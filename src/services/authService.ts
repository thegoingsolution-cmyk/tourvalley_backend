import pool from '../config/database';
import { ResultSetHeader, RowDataPacket } from 'mysql2';
import crypto from 'crypto';

// 비밀번호 해시 함수
const hashPassword = (password: string): string => {
  return crypto.createHash('sha256').update(password).digest('hex');
};

// 회원 정보 인터페이스
interface MemberInfo {
  id: number;
  member_type: string;
  username: string;
  name: string;
  birth_date: string | null;
  gender: string | null;
  email: string;
  email_domain: string | null;
  mobile_phone: string;
  mileage: number;
  accident_free_cash: number;
  marketing_agreed: boolean;
  email_receive: boolean;
  sms_receive: boolean;
  status: string;
}

// 로그인
export const loginMember = async (username: string, password: string): Promise<{ 
  success: boolean; 
  message: string; 
  member?: MemberInfo;
}> => {
  try {
    const hashedPassword = hashPassword(password);

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, member_type, username, name, birth_date, gender, 
              email, email_domain, mobile_phone, mileage, accident_free_cash, 
              marketing_agreed, email_receive, sms_receive, status 
       FROM members 
       WHERE username = ? AND password = ?`,
      [username, hashedPassword]
    );

    if (rows.length === 0) {
      return { 
        success: false, 
        message: '아이디 또는 비밀번호가 일치하지 않습니다.' 
      };
    }

    const member = rows[0] as MemberInfo;

    // 회원 상태 확인
    if (member.status === '휴면') {
      return { 
        success: false, 
        message: '휴면 상태의 계정입니다. 고객센터에 문의해주세요.' 
      };
    }

    if (member.status === '탈퇴') {
      return { 
        success: false, 
        message: '탈퇴한 계정입니다.' 
      };
    }

    // 마지막 로그인 시간 업데이트
    await pool.execute(
      'UPDATE members SET last_login_at = NOW() WHERE id = ?',
      [member.id]
    );

    console.log(`✅ 로그인 성공: ${username} (ID: ${member.id})`);

    return {
      success: true,
      message: '로그인 성공',
      member: {
        id: member.id,
        member_type: member.member_type,
        username: member.username,
        name: member.name,
        birth_date: member.birth_date,
        gender: member.gender,
        email: member.email,
        email_domain: member.email_domain,
        mobile_phone: member.mobile_phone,
        mileage: member.mileage,
        accident_free_cash: member.accident_free_cash,
        marketing_agreed: !!member.marketing_agreed,
        email_receive: !!member.email_receive,
        sms_receive: !!member.sms_receive,
        status: member.status,
      },
    };

  } catch (error) {
    console.error('로그인 오류:', error);
    throw error;
  }
};

// 아이디 중복 확인
export const checkUsernameExists = async (username: string): Promise<boolean> => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM members WHERE username = ?',
    [username]
  );
  return rows.length > 0;
};

// 휴대폰 인증 여부 확인
export const checkPhoneVerified = async (phone: string): Promise<boolean> => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM phone_verifications WHERE mobile_phone = ? AND verified = 1 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
    [phone]
  );
  return rows.length > 0;
};

// 개인회원 가입
interface PersonalMemberData {
  username: string;
  password: string;
  name: string;
  birthDate?: string;
  gender?: string;
  email: string;
  emailDomain?: string;
  phone: string;
  termsAgreed: boolean;
  privacyAgreed: boolean;
  marketingAgreed: boolean;
}

export const registerPersonalMember = async (data: PersonalMemberData): Promise<{ success: boolean; message: string; memberId?: number }> => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // 아이디 중복 확인
    const usernameExists = await checkUsernameExists(data.username);
    if (usernameExists) {
      return { success: false, message: '이미 사용중인 아이디입니다.' };
    }

    // 휴대폰 인증 확인
    const phoneVerified = await checkPhoneVerified(data.phone);
    if (!phoneVerified) {
      return { success: false, message: '휴대폰 인증이 완료되지 않았습니다.' };
    }

    // 비밀번호 해시
    const hashedPassword = hashPassword(data.password);

    // 성별 변환
    const genderValue = data.gender === 'male' ? '남자' : data.gender === 'female' ? '여자' : null;

    // 회원 등록
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO members (
        member_type, username, password, name, birth_date, gender, 
        email, email_domain, mobile_phone, phone_verified, phone_verified_at,
        terms_agreed, privacy_agreed, marketing_agreed, mileage
      ) VALUES (
        '개인', ?, ?, ?, ?, ?, 
        ?, ?, ?, 1, NOW(),
        ?, ?, ?, 1000
      )`,
      [
        data.username,
        hashedPassword,
        data.name,
        data.birthDate || null,
        genderValue,
        data.email,
        data.emailDomain || null,
        data.phone,
        data.termsAgreed ? 1 : 0,
        data.privacyAgreed ? 1 : 0,
        data.marketingAgreed ? 1 : 0,
      ]
    );

    const memberId = result.insertId;

    // members 테이블의 mileage 조회 (회원가입 시 1000P로 설정됨)
    const [memberResult] = await connection.execute<any[]>(
      `SELECT mileage FROM members WHERE id = ?`,
      [memberId]
    );
    const balance = memberResult[0]?.mileage || 1000;

    // 마일리지 이력 추가 (회원가입 축하 1000P)
    await connection.execute(
      `INSERT INTO mileage_transactions (
        member_id, type, amount, balance, description, reason, reason_detail, reference_type
      ) VALUES (?, 'earn', 1000, ?, '회원가입 축하 마일리지', '회원가입 축하 마일리지', '회원가입시 1000P 지급', 'signup')`,
      [memberId, balance]
    );

    await connection.commit();

    console.log(`✅ 개인회원 가입 완료: ${data.username} (ID: ${memberId})`);

    return {
      success: true,
      message: '회원가입이 완료되었습니다.',
      memberId,
    };

  } catch (error) {
    await connection.rollback();
    console.error('회원가입 오류:', error);
    throw error;
  } finally {
    connection.release();
  }
};

// 법인회원 가입
interface CorporateContact {
  name: string;
  department?: string;
  position?: string;
  email?: string;
  emailDomain?: string;
  phone?: string;
  isPrimary?: boolean;
}

interface CorporateMemberData {
  username: string;
  password: string;
  companyName: string;
  businessNumber: string;
  contacts: CorporateContact[];
  comprehensiveContract: boolean;
  termsAgreed: boolean;
  privacyAgreed: boolean;
  marketingAgreed: boolean;
  // 대표 담당자 정보 (인증용)
  primaryPhone: string;
  // 사업자등록증 파일 정보
  businessFilePath?: string;
  businessFileName?: string;
}

export const registerCorporateMember = async (data: CorporateMemberData): Promise<{ success: boolean; message: string; memberId?: number }> => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // 아이디 중복 확인
    const usernameExists = await checkUsernameExists(data.username);
    if (usernameExists) {
      return { success: false, message: '이미 사용중인 아이디입니다.' };
    }

    // 휴대폰 인증 확인
    const phoneVerified = await checkPhoneVerified(data.primaryPhone);
    if (!phoneVerified) {
      return { success: false, message: '휴대폰 인증이 완료되지 않았습니다.' };
    }

    // 비밀번호 해시
    const hashedPassword = hashPassword(data.password);

    // 대표 담당자 정보
    const primaryContact = data.contacts[0];

    // 회원 등록
    const [memberResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO members (
        member_type, username, password, name, 
        email, email_domain, mobile_phone, phone_verified, phone_verified_at,
        terms_agreed, privacy_agreed, marketing_agreed, mileage
      ) VALUES (
        '법인', ?, ?, ?, 
        ?, ?, ?, 1, NOW(),
        ?, ?, ?, 1000
      )`,
      [
        data.username,
        hashedPassword,
        primaryContact.name,
        primaryContact.email || '',
        primaryContact.emailDomain || null,
        data.primaryPhone,
        data.termsAgreed ? 1 : 0,
        data.privacyAgreed ? 1 : 0,
        data.marketingAgreed ? 1 : 0,
      ]
    );

    const memberId = memberResult.insertId;

    // 법인회원 정보 등록
    const [corporateResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO corporate_members (
        member_id, company_name, business_number, comprehensive_contract,
        business_file_path, business_file_name
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        memberId,
        data.companyName,
        data.businessNumber,
        data.comprehensiveContract ? 1 : 0,
        data.businessFilePath || null,
        data.businessFileName || null,
      ]
    );

    const corporateMemberId = corporateResult.insertId;

    // 담당자 정보 등록
    for (let i = 0; i < data.contacts.length; i++) {
      const contact = data.contacts[i];
      const fullEmail = contact.email && contact.emailDomain 
        ? `${contact.email}@${contact.emailDomain}` 
        : contact.email || null;

      await connection.execute(
        `INSERT INTO corporate_contacts (
          corporate_member_id, contact_name, department, position, 
          email, mobile_phone, is_primary
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          corporateMemberId,
          contact.name,
          contact.department || null,
          contact.position || null,
          fullEmail,
          contact.phone || null,
          i === 0 ? 1 : 0, // 첫 번째 담당자가 대표 담당자
        ]
      );
    }

    // members 테이블의 mileage 조회 (회원가입 시 1000P로 설정됨)
    const [mileageResult] = await connection.execute<any[]>(
      `SELECT mileage FROM members WHERE id = ?`,
      [memberId]
    );
    const balance = mileageResult[0]?.mileage || 1000;

    // 마일리지 이력 추가 (회원가입 축하 1000P)
    await connection.execute(
      `INSERT INTO mileage_transactions (
        member_id, type, amount, balance, description, reason, reason_detail, reference_type
      ) VALUES (?, 'earn', 1000, ?, '회원가입 축하 마일리지', '회원가입 축하 마일리지', '회원가입시 1000P 지급', 'signup')`,
      [memberId, balance]
    );

    await connection.commit();

    console.log(`✅ 법인회원 가입 완료: ${data.username} (ID: ${memberId})`);

    return {
      success: true,
      message: '회원가입이 완료되었습니다.',
      memberId,
    };

  } catch (error) {
    await connection.rollback();
    console.error('법인회원 가입 오류:', error);
    throw error;
  } finally {
    connection.release();
  }
};

// 회원 정보 수정
interface UpdateMemberData {
  password?: string;
  email?: string;
  emailDomain?: string;
  mobilePhone?: string;
  marketingAgreed?: boolean;
  emailReceive?: boolean;
  smsReceive?: boolean;
}

export const updateMember = async (
  memberId: number, 
  data: UpdateMemberData
): Promise<{ success: boolean; message: string; member?: MemberInfo }> => {
  try {
    // 업데이트할 필드 동적 생성
    const updateFields: string[] = [];
    const updateValues: any[] = [];

    if (data.password) {
      updateFields.push('password = ?');
      updateValues.push(hashPassword(data.password));
    }

    if (data.email !== undefined) {
      updateFields.push('email = ?');
      updateValues.push(data.email);
    }

    if (data.emailDomain !== undefined) {
      updateFields.push('email_domain = ?');
      updateValues.push(data.emailDomain);
    }

    if (data.mobilePhone !== undefined) {
      updateFields.push('mobile_phone = ?');
      updateValues.push(data.mobilePhone);
    }

    if (data.marketingAgreed !== undefined) {
      updateFields.push('marketing_agreed = ?');
      updateValues.push(data.marketingAgreed ? 1 : 0);
    }

    if (data.emailReceive !== undefined) {
      updateFields.push('email_receive = ?');
      updateValues.push(data.emailReceive ? 1 : 0);
    }

    if (data.smsReceive !== undefined) {
      updateFields.push('sms_receive = ?');
      updateValues.push(data.smsReceive ? 1 : 0);
    }

    if (updateFields.length === 0) {
      return {
        success: false,
        message: '수정할 정보가 없습니다.',
      };
    }

    // 업데이트 쿼리 실행
    updateValues.push(memberId);
    await pool.execute(
      `UPDATE members SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
      updateValues
    );

    // 업데이트된 회원 정보 조회
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, member_type, username, name, birth_date, gender, 
              email, email_domain, mobile_phone, mileage, accident_free_cash, 
              marketing_agreed, email_receive, sms_receive, status 
       FROM members 
       WHERE id = ?`,
      [memberId]
    );

    if (rows.length === 0) {
      return {
        success: false,
        message: '회원 정보를 찾을 수 없습니다.',
      };
    }

    const member = rows[0];

    console.log(`✅ 회원정보 수정 완료: ID ${memberId}`);

    return {
      success: true,
      message: '회원정보가 성공적으로 수정되었습니다.',
      member: {
        id: member.id,
        member_type: member.member_type,
        username: member.username,
        name: member.name,
        birth_date: member.birth_date,
        gender: member.gender,
        email: member.email,
        email_domain: member.email_domain,
        mobile_phone: member.mobile_phone,
        mileage: member.mileage,
        accident_free_cash: member.accident_free_cash,
        marketing_agreed: !!member.marketing_agreed,
        email_receive: !!member.email_receive,
        sms_receive: !!member.sms_receive,
        status: member.status,
      },
    };

  } catch (error) {
    console.error('회원정보 수정 오류:', error);
    throw error;
  }
};

// 법인회원 정보 타입
interface CorporateInfo {
  id: number;
  company_name: string;
  business_number: string;
  comprehensive_contract: boolean;
  business_file_path: string | null;
  business_file_name: string | null;
}

interface ContactInfo {
  id: number;
  contact_name: string;
  department: string | null;
  position: string | null;
  email: string | null;
  mobile_phone: string | null;
  is_primary: boolean;
}

// 법인회원 정보 조회
export const getCorporateMemberInfo = async (memberId: number): Promise<{
  success: boolean;
  message: string;
  corporate?: CorporateInfo;
  contacts?: ContactInfo[];
}> => {
  try {
    // 법인회원 정보 조회
    const [corporateRows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, company_name, business_number, comprehensive_contract, business_file_path, business_file_name 
       FROM corporate_members 
       WHERE member_id = ?`,
      [memberId]
    );

    if (corporateRows.length === 0) {
      return {
        success: false,
        message: '법인회원 정보를 찾을 수 없습니다.',
      };
    }

    const corporate = corporateRows[0];

    // 담당자 정보 조회
    const [contactRows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, contact_name, department, position, email, mobile_phone, is_primary 
       FROM corporate_contacts 
       WHERE corporate_member_id = ?
       ORDER BY is_primary DESC, id ASC`,
      [corporate.id]
    );

    console.log(`✅ 법인회원 정보 조회 완료: 회원 ID ${memberId}`);

    return {
      success: true,
      message: '법인회원 정보 조회 성공',
      corporate: {
        id: corporate.id,
        company_name: corporate.company_name,
        business_number: corporate.business_number,
        comprehensive_contract: !!corporate.comprehensive_contract,
        business_file_path: corporate.business_file_path,
        business_file_name: corporate.business_file_name,
      },
      contacts: contactRows.map((contact: any) => ({
        id: contact.id,
        contact_name: contact.contact_name,
        department: contact.department,
        position: contact.position,
        email: contact.email,
        mobile_phone: contact.mobile_phone,
        is_primary: !!contact.is_primary,
      })),
    };

  } catch (error) {
    console.error('법인회원 정보 조회 오류:', error);
    throw error;
  }
};

// 법인회원 정보 수정
interface UpdateCorporateMemberData {
  password?: string;
  contacts?: {
    id?: number;
    contact_name: string;
    department?: string;
    position?: string;
    email?: string;
    emailDomain?: string;
    mobile_phone?: string;
  }[];
  comprehensiveContract?: boolean;
  marketingAgreed?: boolean;
  emailReceive?: boolean;
  smsReceive?: boolean;
  businessFilePath?: string;
  businessFileName?: string;
}

export const updateCorporateMember = async (
  memberId: number,
  data: UpdateCorporateMemberData
): Promise<{ success: boolean; message: string }> => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // 비밀번호 업데이트 (입력된 경우)
    if (data.password) {
      await connection.execute(
        'UPDATE members SET password = ?, updated_at = NOW() WHERE id = ?',
        [hashPassword(data.password), memberId]
      );
    }

    // 마케팅 수신 동의 업데이트
    const updateMemberFields: string[] = [];
    const updateMemberValues: any[] = [];

    if (data.marketingAgreed !== undefined) {
      updateMemberFields.push('marketing_agreed = ?');
      updateMemberValues.push(data.marketingAgreed ? 1 : 0);
    }
    if (data.emailReceive !== undefined) {
      updateMemberFields.push('email_receive = ?');
      updateMemberValues.push(data.emailReceive ? 1 : 0);
    }
    if (data.smsReceive !== undefined) {
      updateMemberFields.push('sms_receive = ?');
      updateMemberValues.push(data.smsReceive ? 1 : 0);
    }

    if (updateMemberFields.length > 0) {
      updateMemberValues.push(memberId);
      await connection.execute(
        `UPDATE members SET ${updateMemberFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
        updateMemberValues
      );
    }

    // 법인회원 정보 조회
    const [corporateRows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM corporate_members WHERE member_id = ?',
      [memberId]
    );

    if (corporateRows.length === 0) {
      await connection.rollback();
      return { success: false, message: '법인회원 정보를 찾을 수 없습니다.' };
    }

    const corporateMemberId = corporateRows[0].id;

    // 포괄계약 신청 여부 및 사업자등록증 파일 업데이트
    const updateCorporateFields: string[] = [];
    const updateCorporateValues: any[] = [];

    if (data.comprehensiveContract !== undefined) {
      updateCorporateFields.push('comprehensive_contract = ?');
      updateCorporateValues.push(data.comprehensiveContract ? 1 : 0);
    }

    if (data.businessFilePath !== undefined) {
      updateCorporateFields.push('business_file_path = ?');
      updateCorporateValues.push(data.businessFilePath);
    }

    if (data.businessFileName !== undefined) {
      updateCorporateFields.push('business_file_name = ?');
      updateCorporateValues.push(data.businessFileName);
    }

    if (updateCorporateFields.length > 0) {
      updateCorporateValues.push(corporateMemberId);
      await connection.execute(
        `UPDATE corporate_members SET ${updateCorporateFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
        updateCorporateValues
      );
    }

    // 담당자 정보 업데이트
    if (data.contacts && data.contacts.length > 0) {
      for (const contact of data.contacts) {
        const fullEmail = contact.email && contact.emailDomain 
          ? `${contact.email}@${contact.emailDomain}` 
          : contact.email || null;

        if (contact.id) {
          // 기존 담당자 업데이트
          await connection.execute(
            `UPDATE corporate_contacts 
             SET contact_name = ?, department = ?, position = ?, email = ?, mobile_phone = ?, updated_at = NOW()
             WHERE id = ?`,
            [
              contact.contact_name,
              contact.department || null,
              contact.position || null,
              fullEmail,
              contact.mobile_phone || null,
              contact.id,
            ]
          );
        } else {
          // 새 담당자 추가
          await connection.execute(
            `INSERT INTO corporate_contacts 
             (corporate_member_id, contact_name, department, position, email, mobile_phone, is_primary)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
            [
              corporateMemberId,
              contact.contact_name,
              contact.department || null,
              contact.position || null,
              fullEmail,
              contact.mobile_phone || null,
            ]
          );
        }
      }

      // 대표 담당자 정보로 members 테이블 업데이트
      const primaryContact = data.contacts[0];
      const primaryEmail = primaryContact.email && primaryContact.emailDomain 
        ? `${primaryContact.email}@${primaryContact.emailDomain}` 
        : primaryContact.email || null;

      await connection.execute(
        `UPDATE members 
         SET name = ?, email = ?, email_domain = ?, mobile_phone = ?, updated_at = NOW()
         WHERE id = ?`,
        [
          primaryContact.contact_name,
          primaryContact.email || null,
          primaryContact.emailDomain || null,
          primaryContact.mobile_phone || null,
          memberId,
        ]
      );
    }

    await connection.commit();

    console.log(`✅ 법인회원 정보 수정 완료: 회원 ID ${memberId}`);

    return {
      success: true,
      message: '법인회원 정보가 성공적으로 수정되었습니다.',
    };

  } catch (error) {
    await connection.rollback();
    console.error('법인회원 정보 수정 오류:', error);
    throw error;
  } finally {
    connection.release();
  }
};

