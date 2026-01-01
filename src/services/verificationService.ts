import pool from '../config/database';
import { generateVerificationCode, sendVerificationSms } from './aligoService';
import { RowDataPacket } from 'mysql2';

interface VerificationRecord extends RowDataPacket {
  id: number;
  mobile_phone: string;
  verification_code: string;
  verified: number;
  expires_at: Date;
  created_at: Date;
}

/**
 * 인증번호 발송 및 저장
 */
export const sendVerification = async (
  phoneNumber: string,
  testmode: boolean = false
): Promise<{ success: boolean; message: string; code?: string }> => {
  const connection = await pool.getConnection();
  
  try {
    // 1. 인증번호 생성
    const code = generateVerificationCode();
    
    // 2. 만료 시간 설정 (3분 후)
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
    
    // 3. 기존 미사용 인증 레코드 삭제 (같은 번호)
    await connection.execute(
      'DELETE FROM phone_verifications WHERE mobile_phone = ? AND verified = 0',
      [phoneNumber]
    );
    
    // 4. 새 인증 레코드 저장
    await connection.execute(
      `INSERT INTO phone_verifications (mobile_phone, verification_code, verified, expires_at, created_at)
       VALUES (?, ?, 0, ?, NOW())`,
      [phoneNumber, code, expiresAt]
    );
    
    // 5. SMS 발송 (테스트 모드가 아닐 때만 실제 발송)
    if (!testmode) {
      const result = await sendVerificationSms(phoneNumber, code);
      const resultCode = String(result.result_code);
      
      if (resultCode !== '1') {
        throw new Error(result.message || 'SMS 발송 실패');
      }
    }
    
    return {
      success: true,
      message: '인증번호가 발송되었습니다.',
      // 테스트 모드에서만 코드 반환 (개발용)
      ...(testmode && { code }),
    };
  } catch (error) {
    throw error;
  } finally {
    connection.release();
  }
};

/**
 * 인증번호 확인
 */
export const verifyCode = async (
  phoneNumber: string,
  code: string
): Promise<{ success: boolean; message: string }> => {
  const connection = await pool.getConnection();
  
  try {
    // 1. 인증 레코드 조회
    const [rows] = await connection.execute<VerificationRecord[]>(
      `SELECT * FROM phone_verifications 
       WHERE mobile_phone = ? AND verification_code = ? AND verified = 0
       ORDER BY created_at DESC LIMIT 1`,
      [phoneNumber, code]
    );
    
    if (rows.length === 0) {
      return {
        success: false,
        message: '인증번호가 일치하지 않습니다.',
      };
    }
    
    const record = rows[0];
    
    // 2. 만료 시간 확인
    if (new Date() > new Date(record.expires_at)) {
      return {
        success: false,
        message: '인증번호가 만료되었습니다. 다시 요청해주세요.',
      };
    }
    
    // 3. 인증 완료 처리
    await connection.execute(
      'UPDATE phone_verifications SET verified = 1 WHERE id = ?',
      [record.id]
    );
    
    return {
      success: true,
      message: '인증이 완료되었습니다.',
    };
  } catch (error) {
    throw error;
  } finally {
    connection.release();
  }
};

/**
 * 특정 번호의 인증 상태 확인
 */
export const checkVerificationStatus = async (
  phoneNumber: string
): Promise<{ verified: boolean; expiresAt?: Date }> => {
  const connection = await pool.getConnection();
  
  try {
    const [rows] = await connection.execute<VerificationRecord[]>(
      `SELECT * FROM phone_verifications 
       WHERE mobile_phone = ? AND verified = 1
       ORDER BY created_at DESC LIMIT 1`,
      [phoneNumber]
    );
    
    if (rows.length === 0) {
      return { verified: false };
    }
    
    return {
      verified: true,
      expiresAt: rows[0].expires_at,
    };
  } finally {
    connection.release();
  }
};

export default {
  sendVerification,
  verifyCode,
  checkVerificationStatus,
};
