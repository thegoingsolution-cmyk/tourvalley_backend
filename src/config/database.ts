import mysql, { Pool, PoolConnection, PoolOptions } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT || '20', 10);
const maxIdle = parseInt(process.env.DB_MAX_IDLE || '3', 10);
const acquireTimeoutMs = parseInt(process.env.DB_ACQUIRE_TIMEOUT_MS || '10000', 10);
const queueLimit = parseInt(process.env.DB_QUEUE_LIMIT || '50', 10);

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

pool.getConnection = (() =>
  withAcquireTimeout(() =>
    withRetry(() => acquireValidatedConnection(), 2)
  )) as typeof pool.getConnection;

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
