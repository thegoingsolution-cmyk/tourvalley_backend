import axios from 'axios';
import FormData from 'form-data';

// 알리고 API 설정
const ALIGO_API_URL = 'https://apis.aligo.in';
const ALIGO_USER_ID = process.env.ALIGO_USER_ID || '7colours';
const ALIGO_API_KEY = process.env.ALIGO_API_KEY || 'dm0jmvrrlw0i5k5js8gnf8so0uu2lhew';
const ALIGO_SENDER = process.env.ALIGO_SENDER || ''; // 발신번호 (사전 등록 필요)

interface AligoSendResult {
  result_code: string;
  message: string;
  msg_id?: string;
  success_cnt?: number;
  error_cnt?: number;
  msg_type?: string;
  [key: string]: any;
}

interface SendSmsParams {
  receiver: string;  // 수신자 번호
  message: string;   // 메시지 내용
  title?: string;    // LMS/MMS 제목
  testmode?: boolean; // 테스트 모드
}

/**
 * 6자리 인증번호 생성
 */
export const generateVerificationCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * 알리고 SMS 발송
 */
export const sendSms = async (params: SendSmsParams): Promise<AligoSendResult> => {
  const { receiver, message, title, testmode = false } = params;

  // 발신번호 확인
  if (!ALIGO_SENDER) {
    throw new Error('발신번호(ALIGO_SENDER)가 설정되지 않았습니다. 관리자에게 문의하세요.');
  }

  // FormData 생성
  const formData = new FormData();
  formData.append('key', ALIGO_API_KEY);
  formData.append('user_id', ALIGO_USER_ID);
  formData.append('sender', ALIGO_SENDER);
  formData.append('receiver', receiver.replace(/-/g, '')); // 하이픈 제거
  formData.append('msg', message);
  
  if (title) {
    formData.append('title', title);
    formData.append('msg_type', 'LMS'); // 장문 메시지
  } else {
    formData.append('msg_type', 'SMS'); // 단문 메시지
  }

  if (testmode) {
    formData.append('testmode_yn', 'Y');
  }

  try {
    const response = await axios.post<AligoSendResult>(
      `${ALIGO_API_URL}/send/`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
      }
    );

    return response.data;
  } catch (error) {
    throw new Error('SMS 발송에 실패했습니다.');
  }
};

/**
 * 인증번호 SMS 발송
 */
export const sendVerificationSms = async (
  phoneNumber: string,
  code: string,
  testmode: boolean = false
): Promise<AligoSendResult> => {
  const message = `[투어밸리] 인증번호는 [${code}]입니다. 3분 이내에 입력해주세요.`;
  
  return sendSms({
    receiver: phoneNumber,
    message,
    testmode,
  });
};

/**
 * 알리고 잔여 SMS 조회
 */
export const checkRemainSms = async (): Promise<{ remain_cnt: number }> => {
  const formData = new FormData();
  formData.append('key', ALIGO_API_KEY);
  formData.append('user_id', ALIGO_USER_ID);

  try {
    const response = await axios.post(
      `${ALIGO_API_URL}/remain/`,
      formData,
      {
        headers: {
          ...formData.getHeaders(),
        },
      }
    );

    return response.data;
  } catch (error) {
    throw new Error('잔여 SMS 조회에 실패했습니다.');
  }
};

export default {
  generateVerificationCode,
  sendSms,
  sendVerificationSms,
  checkRemainSms,
};
