import type { PoolConnection } from 'mysql2/promise';

const isIgnorableConnectionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('closed state') || message.includes('Connection lost');
};

/** 트랜잭션 rollback 실패가 프로세스를 죽이지 않도록 방어 */
export const safeRollback = async (
  connection: PoolConnection | null | undefined
): Promise<void> => {
  if (!connection) return;

  try {
    await connection.rollback();
  } catch (error) {
    if (!isIgnorableConnectionError(error)) {
      console.warn('safeRollback:', error instanceof Error ? error.message : error);
    }
  }
};

/** 이미 반환된 커넥션 release 시 예외 방어 */
export const safeRelease = (connection: PoolConnection | null | undefined): void => {
  if (!connection) return;

  try {
    connection.release();
  } catch (error) {
    if (!isIgnorableConnectionError(error)) {
      console.warn('safeRelease:', error instanceof Error ? error.message : error);
    }
  }
};
