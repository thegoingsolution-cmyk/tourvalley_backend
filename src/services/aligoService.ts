import axios from 'axios';
import FormData from 'form-data';
import { URLSearchParams } from 'url';

// 알리고 API 설정
const ALIGO_API_URL = 'https://apis.aligo.in';
const ALIGO_ALIMTALK_API_URL = 'https://kakaoapi.aligo.in/akv10/alimtalk';
const ALIGO_USER_ID = process.env.ALIGO_USER_ID || '7colours';
const ALIGO_API_KEY = process.env.ALIGO_API_KEY || 'dm0jmvrrlw0i5k5js8gnf8so0uu2lhew';
const ALIGO_SENDER_KEY = process.env.ALIGO_SENDER_KEY || ''; // 발신 프로필 키
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

interface AligoAlimTalkResult {
  code?: number | string;
  result_code?: number | string;
  message: string;
  msg_id?: string;
  success_cnt?: number;
  error_cnt?: number;
  info?: {
    mid?: string;  // 메시지 ID
    type?: string;  // 'AT' = 알림톡 요청, 'SMS' = 대체문자
    scnt?: number;  // 성공 건수
    fcnt?: number;  // 실패 건수
  };
  [key: string]: any;
}

interface SendAlimTalkParams {
  receiver: string;  // 수신자 번호
  template_code: string;  // 템플릿 코드 (예: UE_8117)
  subject: string;  // 알림톡 제목
  message: string;  // 메시지 내용 (템플릿과 동일한 구조)
  receiver_name?: string;  // 수신자 이름
  button?: {
    name: string;
    linkType: 'WL' | 'AL' | 'BK' | 'MD' | 'DS' | 'AC';  // AC: 채널 추가 버튼
    linkMo?: string;
    linkPc?: string;
    linkIos?: string;
    linkAndroid?: string;
  }[];
  testmode?: boolean; // 테스트 모드
  failover?: string; // 대체문자 발송 여부 ('Y' 또는 'N', 기본값 'Y')
  failoverSubject?: string; // 대체문자 제목
  failoverMessage?: string; // 대체문자 내용
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
 * 알리고 알림톡 발송
 */
export const sendAlimTalk = async (params: SendAlimTalkParams): Promise<AligoAlimTalkResult> => {
  const {
    receiver,
    template_code,
    subject,
    message,
    receiver_name,
    button,
    testmode = false,
    failover = 'Y',
    failoverSubject,
    failoverMessage,
  } = params;

  // 발신 프로필 키 확인
  if (!ALIGO_SENDER_KEY) {
    throw new Error('발신 프로필 키(ALIGO_SENDER_KEY)가 설정되지 않았습니다. 관리자에게 문의하세요.');
  }

  // 발신번호 확인
  if (!ALIGO_SENDER) {
    throw new Error('발신번호(ALIGO_SENDER)가 설정되지 않았습니다. 관리자에게 문의하세요.');
  }

  // 전화번호에서 하이픈 제거
  const cleanReceiver = receiver.replace(/[^0-9]/g, '');
  const cleanSender = ALIGO_SENDER.replace(/[^0-9]/g, '');

  // URLSearchParams 사용 (알리고 API 권장 방식)
  const requestParams = new URLSearchParams();
  requestParams.append('apikey', ALIGO_API_KEY);
  requestParams.append('userid', ALIGO_USER_ID);
  requestParams.append('senderkey', ALIGO_SENDER_KEY);
  requestParams.append('tpl_code', template_code);
  requestParams.append('sender', cleanSender);
  requestParams.append('receiver_1', cleanReceiver);
  requestParams.append('subject_1', subject);
  requestParams.append('message_1', message);

  // 수신자 이름 (선택)
  if (receiver_name) {
    requestParams.append('recvname_1', receiver_name);
  }

  // 버튼 정보 (선택)
  if (button && button.length > 0) {
    const buttonData = {
      button: button.map((btn) => {
        const btnObj: any = {
          name: btn.name,
          linkType: btn.linkType,
        };
        // AC 타입(채널 추가)은 링크 정보가 필요 없음
        if (btn.linkType !== 'AC') {
          if (btn.linkMo) btnObj.linkMo = btn.linkMo;
          if (btn.linkPc) btnObj.linkPc = btn.linkPc;
          if (btn.linkIos) btnObj.linkIos = btn.linkIos;
          if (btn.linkAndroid) btnObj.linkAndroid = btn.linkAndroid;
        }
        return btnObj;
      }),
    };
    requestParams.append('button_1', JSON.stringify(buttonData));
  }

  // 대체문자 발송 여부
  requestParams.append('failover', failover);

  // failover가 'Y'인 경우, fsubject_1과 fmessage_1이 필수
  if (failover === 'Y') {
    requestParams.append('fsubject_1', failoverSubject || '[투어밸리]');
    requestParams.append('fmessage_1', failoverMessage || message.substring(0, 80));
  }

  // 테스트 모드
  if (testmode) {
    requestParams.append('testMode', 'Y');
  }

  try {
    const response = await axios.post<AligoAlimTalkResult>(
      `${ALIGO_ALIMTALK_API_URL}/send/`,
      requestParams,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    // 알리고 API 응답 확인
    // code 또는 result_code가 0 또는 1이면 성공
    const code = response.data.code !== undefined ? response.data.code : response.data.result_code;
    const responseMessage = response.data.message || '';
    const isSuccess = code === 0 || code === '0' || code === 1 || code === '1';

    if (isSuccess) {
      return response.data;
    }

    throw new Error(responseMessage || '알림톡 발송에 실패했습니다.');
  } catch (error: any) {
    if (error.response?.data) {
      const errorMessage = error.response.data.message || '알림톡 발송에 실패했습니다.';
      throw new Error(errorMessage);
    }
    throw new Error(error.message || '알림톡 발송에 실패했습니다.');
  }
};

/**
 * 템플릿 코드와 메시지를 받아서 알림톡 발송 (범용 함수)
 */
export const sendAlimTalkWithMessage = async (
  receiver: string,
  template_code: string,
  subject: string,
  message: string,
  receiver_name?: string,
  buttons?: {
    name: string;
    linkType: 'WL' | 'AL' | 'BK' | 'MD' | 'DS' | 'AC';
    linkMo?: string;
    linkPc?: string;
    linkIos?: string;
    linkAndroid?: string;
  }[],
  testmode: boolean = false
): Promise<AligoAlimTalkResult> => {
  // HTML 태그(<br>)를 줄바꿈(\n)으로 변환
  const plainMessage = message
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();

  return sendAlimTalk({
    receiver,
    template_code,
    subject,
    message: plainMessage,
    receiver_name,
    button: buttons,
    testmode,
  });
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
  sendAlimTalk,
  sendAlimTalkWithMessage,
};
