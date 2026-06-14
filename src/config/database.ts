import mysql, { Pool, PoolOptions } from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT || '20', 10);
const maxIdle = parseInt(process.env.DB_MAX_IDLE || String(Math.max(5, Math.floor(connectionLimit / 3))), 10);

const poolOptions: PoolOptions = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bzvalley',
  waitForConnections: true,
  connectionLimit,
  maxIdle,
  idleTimeout: 60_000,
  queueLimit: 0,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
};

const pool: Pool = mysql.createPool(poolOptions);

pool.on('connection', (connection) => {
  connection.on('error', (err) => {
    console.error('MySQL pool connection error:', err.message);
  });
});

const isStaleConnectionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException)?.code;

  return (
    message.includes('closed state') ||
    message.includes('Connection lost') ||
    message.includes('server has gone away') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'PROTOCOL_CONNECTION_LOST'
  );
};

const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (!isStaleConnectionError(error)) {
      throw error;
    }

    console.warn(
      'MySQL stale connection detected, retrying once...',
      error instanceof Error ? error.message : error
    );
    return operation();
  }
};

const originalExecute = pool.execute.bind(pool);
const originalQuery = pool.query.bind(pool);
const originalGetConnection = pool.getConnection.bind(pool);

pool.execute = ((...args: Parameters<typeof originalExecute>) =>
  withRetry(() => originalExecute(...args))) as typeof pool.execute;

pool.query = ((...args: Parameters<typeof originalQuery>) =>
  withRetry(() => originalQuery(...args))) as typeof pool.query;

pool.getConnection = (() =>
  withRetry(() => originalGetConnection())) as typeof pool.getConnection;

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
