import mysql, { Pool, PoolConnection, PoolOptions } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT || '20', 10);
const maxIdle = parseInt(process.env.DB_MAX_IDLE || '3', 10);
const acquireTimeoutMs = parseInt(process.env.DB_ACQUIRE_TIMEOUT_MS || '10000', 10);
const queueLimit = parseInt(process.env.DB_QUEUE_LIMIT || '50', 10);

/** Queue/acquire 고갈이 이 횟수 이상 연속(윈도우 내)이면 process.exit → PM2 autorestart */
const poolExhaustionExitThreshold = parseInt(
  process.env.DB_POOL_EXHAUSTION_EXIT_THRESHOLD || '5',
  10
);
const poolExhaustionWindowMs = parseInt(
  process.env.DB_POOL_EXHAUSTION_WINDOW_MS || '30000',
  10
);
const poolExhaustionRestartEnabled =
  (process.env.DB_POOL_EXHAUSTION_RESTART || 'true').toLowerCase() !== 'false';

const poolOptions: PoolOptions = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bzvalley',
  waitForConnections: true,
  connectionLimit,
  maxIdle: Math.max(1, Math.min(maxIdle, connectionLimit - 1)),
  idleTimeout: 60_000,
  queueLimit,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
};

const pool: Pool = mysql.createPool(poolOptions);

pool.on('connection', (connection) => {
  connection.on('error', (err) => {
    const message = err.message || '';
    if (
      message.includes('inactivity') ||
      message.includes('disconnected by the server')
    ) {
      console.warn('MySQL pool idle connection closed:', message);
      return;
    }
    console.error('MySQL pool connection error:', message);
  });
});

const isStaleConnectionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException)?.code;

  return (
    message.includes('closed state') ||
    message.includes('Connection lost') ||
    message.includes('server has gone away') ||
    message.includes('inactivity') ||
    message.includes('disconnected by the server') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ER_CLIENT_INTERACTION_TIMEOUT'
  );
};

/** 풀 대기 큐 고갈 또는 acquire 타임아웃 — 커넥션이 사실상 고갈된 상태 */
const isPoolExhaustedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Queue limit reached') ||
    message.includes('MySQL pool acquire timeout')
  );
};

let poolExhaustionHits = 0;
let poolExhaustionWindowStart = 0;
let poolRestartScheduled = false;

/**
 * 풀 고갈이 단발이면 요청만 실패시키고,
 * 짧은 시간 안에 반복되면 PM2가 잡을 수 있게 process.exit(1).
 * (커넥션 릭/좀비 대기로 프로세스만 살아 있는 상태 해소)
 */
const maybeRestartOnPoolExhaustion = (error: unknown): void => {
  if (!poolExhaustionRestartEnabled || !isPoolExhaustedError(error)) {
    return;
  }

  const now = Date.now();
  if (now - poolExhaustionWindowStart > poolExhaustionWindowMs) {
    poolExhaustionWindowStart = now;
    poolExhaustionHits = 0;
  }

  poolExhaustionHits += 1;

  console.error(
    `[DB pool] exhausted (${poolExhaustionHits}/${poolExhaustionExitThreshold} in ${poolExhaustionWindowMs}ms):`,
    error instanceof Error ? error.message : error
  );

  if (poolExhaustionHits < poolExhaustionExitThreshold || poolRestartScheduled) {
    return;
  }

  poolRestartScheduled = true;
  console.error(
    '[DB pool] repeated exhaustion — exiting process for PM2 autorestart (clears stuck pool)'
  );
  // 진행 중 로그 flush 여유
  setTimeout(() => process.exit(1), 500);
};

const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries = 1
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      maybeRestartOnPoolExhaustion(error);
      if (!isStaleConnectionError(error) || attempt === maxRetries) {
        throw error;
      }

      console.warn(
        'MySQL stale connection detected, retrying...',
        error instanceof Error ? error.message : error
      );
    }
  }

  throw lastError;
};

const withAcquireTimeout = <T>(operation: () => Promise<T>): Promise<T> =>
  Promise.race([
    operation(),
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `MySQL pool acquire timeout after ${acquireTimeoutMs}ms`
          )
        );
      }, acquireTimeoutMs);
    }),
  ]);

const originalExecute = pool.execute.bind(pool);
const originalQuery = pool.query.bind(pool);
const originalGetConnection = pool.getConnection.bind(pool);

const pingConnection = async (connection: PoolConnection): Promise<void> => {
  await connection.execute('SELECT 1');
};

const acquireValidatedConnection = async (): Promise<PoolConnection> => {
  const connection = await originalGetConnection();

  try {
    await pingConnection(connection);
    return connection;
  } catch (error) {
    try {
      connection.destroy();
    } catch {
      // dead connection destroy may fail
    }
    throw error;
  }
};

pool.execute = ((...args: Parameters<typeof originalExecute>) =>
  withRetry(() => originalExecute(...args))) as typeof pool.execute;

pool.query = ((...args: Parameters<typeof originalQuery>) =>
  withRetry(() => originalQuery(...args))) as typeof pool.query;

pool.getConnection = (async () => {
  try {
    return await withAcquireTimeout(() =>
      withRetry(() => acquireValidatedConnection(), 2)
    );
  } catch (error) {
    // acquire timeout은 withRetry 밖에서 reject되므로 여기서도 고갈 감지
    maybeRestartOnPoolExhaustion(error);
    throw error;
  }
}) as typeof pool.getConnection;

export const pingDatabase = async (): Promise<boolean> => {
  try {
    await pool.execute('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database ping failed:', error);
    return false;
  }
};

export const testConnection = async (): Promise<boolean> => {
  const ok = await pingDatabase();
  if (ok) {
    console.log('✅ Database connected successfully');
  } else {
    console.error('❌ Database connection failed');
  }
  return ok;
};

export default pool;
