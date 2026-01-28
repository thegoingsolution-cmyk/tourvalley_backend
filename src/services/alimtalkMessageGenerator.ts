/**
 * 알림톡 템플릿 메시지 생성 서비스
 * 템플릿 타입에 따라 변수를 치환하여 메시지 생성
 */

interface AlimTalkVariables {
  customerName: string;
  queryDate?: string; // 접수 일시
  insuranceProduct?: string; // 보험상품
  insuranceCompany?: string; // 보험회사
  insurancePeriod?: string; // 보험기간
  travelDestination?: string; // 여행지
  participants?: string; // 가입자 및 인원
  premium?: string; // 보험료
}

const SIGNUP_TEMPLATE = `#{고객명}고객님. 감사합니다.


여행자보험, 행사보험 전문

투어밸리의 회원이 되셨습니다.


#{고객명}님의 안전여행 투어밸리가 함께 하겠습니다.


여행자보험은

여행은 물론 체험학습, 현장실습, 수련회, 야유회, 워크샵 등 각종 야외행사시에 가입하는 보험입니다.


투어밸리는

15년 이상 경력의 여행자보험 전문사이트입니다.

해외여행보험, 해외장기체류보험, 국내여행보험, 행사보험 등에 편리하게 가입할 수 있습니다.


투어밸리 이용약관 규정에 의거 회원가입 축하 마일리지 1,000P가 지급되었으며

여행보험 가입시 보험료의 3%를 추가로 적립(1계약당 최대 30,000P 한도)하여 드립니다.

마일리지는 10,000P 단위로 문화상품권으로 교환하실 수 있습니다.


이 메시지는 이용약관 동의에 따라 지급된 마일리지 안내 메시지입니다


감사합니다.


홈페이지

www.tourvalley.net


문의

1599-2541(투어밸리 고객센터 : 월-금 09시-18시)

※ 이 메시지는 계약이나 거래관계로 인해 지급된 마일리지 안내 메시지입니다. [발송근거 가이드 문구]`;

const ESTIMATE_REQUEST_TEMPLATE = `#{고객명}고객님.

여행자보험 견적신청이 접수되었습니다.

접수일시:#{일시}


견적신청 내역

▶상품명 : #{보험상품}

▶보험기간 : #{보험기간}

▶가입자 및 인원 : #{고객명 외 인원}


여행자보험 견적은 일반적으로 고객센터 업무시간 2시간 이내에 메일로 발송됩니다.

견적서가 발송되면 알림톡으로 안내드립니다.

견적서 메일의 견적서 출력하기를 클릭하시면 견적서 출력이 가능합니다.

결제 및 문서가 필요한 경우 이용하시기 바랍니다.


여행자보험에 가입하시려면

투어밸리 여행자보험 스피드센터를 이용하여 손쉽게 가능할 수 있습니다.

홈페이지 주소

www.tourvalley.net


견적일과 보험가입일이 다른 경우 피보험자의 보험나이 변경으로 인해 보험료가 다소간 차이가 있을 수 있습니다.


문의

1599-2541(투어밸리 고객센터 : 월-금 09시-18시)`;

const CONTRACT_COMPLETE_TEMPLATE = `#{고객명}고객님.

#{상품명}에 가입하셨습니다.


#{고객명}님의 안전여행

간편하고 똑똑한 여행자보험

투어밸리가 함께 하겠습니다.


가입내역

▶상품명 : #{상품명}

▶보험회사 : #{보험회사}

▶보험기간 : #{보험기간}

▶여행지 : #{여행지}

▶가입자 및 인원 : #{고객명 외 인원}

▶보험료 : #{보험료}


보험증서는 고객센터 근무시간에 순차적으로 발급됩니다.

보험증서가 발송되면 별도의 알림톡으로 안내드리며

메일로도 발송되니 참고하시기 바랍니다.

홈페이지 주소

www.tourvalley.net


문의

1. 1599-2541(투어밸리 고객센터 : 월-금 09시-18시)

2. 1666-5075(라이나손보 보상과)

3. 1566-7711(메리츠화재 해외장기)


라이나손보 긴급지원서비스

82-2-3449-3500(연중무휴 24시간 접수)`;

const EVENT_ESTIMATE_TEMPLATE = `안녕하세요.

#{고객명}고객님.


행사보험(행사주최자 배상책임) 견적신청이 접수되었습니다.


행사보험 견적서는 고객센터 영업시간(평일 09-18시) 기준으로 통상 2시간 정도 걸립니다. 다만, 체육행사 등 위험한 활동이 포함된 경우 조금 더 시간이 걸릴 수 있습니다.


또한 행사보험 견적에 필수적인 사업자등록증(고유번호증) 또는 행사개요서가 누락된 경우 행사보험 견적이 불가능합니다.


투어밸리는 보험회사의 가입조건 및 보험료를 판단해 귀단체의 행사에 최적화된 견적서를 제공해 드리고 있습니다.

감사합니다.


홈페이지

www.tourvalley.net


문의

1599-2541(투어밸리 고객센터 : 월-금 09시-18시)`;

/**
 * 템플릿 타입별 메시지 생성
 */
export const generateAlimTalkMessage = (
  templateType: string,
  variables: AlimTalkVariables
): string => {
  switch (templateType) {
    case 'signup':
      // UE_8117: 회원 가입
      return SIGNUP_TEMPLATE.replace(/#\{고객명\}/g, variables.customerName);
    case 'estimate_request':
      // UE_8120: 여행자 보험 견적 신청
      return ESTIMATE_REQUEST_TEMPLATE
        .replace(/#\{고객명\}/g, variables.customerName)
        .replace(/#\{일시\}/g, variables.queryDate || '')
        .replace(/#\{보험상품\}/g, variables.insuranceProduct || '')
        .replace(/#\{보험기간\}/g, variables.insurancePeriod || '')
        .replace(/#\{고객명 외 인원\}/g, variables.participants || '');
    case 'contract_complete':
      // UE_8122: 여행자보험 가입완료(국내/해외/해외장기)
      return CONTRACT_COMPLETE_TEMPLATE
        .replace(/#\{고객명\}/g, variables.customerName)
        .replace(/#\{상품명\}/g, variables.insuranceProduct || '')
        .replace(/#\{보험회사\}/g, variables.insuranceCompany || '')
        .replace(/#\{보험기간\}/g, variables.insurancePeriod || '')
        .replace(/#\{여행지\}/g, variables.travelDestination || '')
        .replace(/#\{고객명 외 인원\}/g, variables.participants || '')
        .replace(/#\{보험료\}/g, variables.premium || '');
    case 'event_estimate':
      // UE_8396: 행사보험 견적 신청
      return EVENT_ESTIMATE_TEMPLATE.replace(/#\{고객명\}/g, variables.customerName);

    default:
      return `${variables.customerName}고객님. 감사합니다.`;
  }
};

export default {
  generateAlimTalkMessage,
};
