import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import pool from '../config/database';

dotenv.config();

// Gmail SMTP 설정
const createTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER, // Gmail 주소
      pass: process.env.GMAIL_APP_PASSWORD, // Gmail 앱 비밀번호
    },
  });
};

interface EstimateEmailData {
  contractorName: string;
  contractorEmail: string;
  productCd: string;
  startDate: string;
  startHour: string;
  endDate: string;
  endHour: string;
  tourNum: number;
  participants: Array<{
    sequence: number;
    gender: string;
    birth_date: string;
  }>;
  requestNumber: string;
}

// 생년월일로 나이 계산
export const calculateAge = (birthDate: string): number => {
  const year = parseInt(birthDate.substring(0, 4));
  const month = parseInt(birthDate.substring(4, 6));
  const day = parseInt(birthDate.substring(6, 8));
  const today = new Date();
  const birth = new Date(year, month - 1, day);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
};

// 보험료 계산
export const calculatePremium = async (
  insuranceType: string,
  age: number,
  gender: string,
  planType: string,
  departureDate: string,
  arrivalDate: string
): Promise<number> => {
  try {
    // 15세 미만일 경우 어린이플랜으로 강제 변경
    const finalPlanType = age < 15 ? '어린이플랜' : planType;

    // 보험기간 계산 (일수)
    const departure = new Date(departureDate);
    const arrival = new Date(arrivalDate);
    const diffTime = arrival.getTime() - departure.getTime();
    const periodDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    if (periodDays <= 0) {
      return 0;
    }

    // 연간보험료 조회 (국내여행보험만 고려, 실속플랜 기본값)
    const [premiumRows] = await pool.execute<any[]>(
      `SELECT annual_premium 
       FROM premium_rates 
       WHERE insurance_type = ? 
         AND plan_type = ? 
         AND age = ? 
         AND gender = ? 
         AND has_medical_expense = 0
         AND is_active = 1
       ORDER BY COALESCE(effective_from_date, '1900-01-01') DESC, id DESC
       LIMIT 1`,
      [insuranceType, finalPlanType, age, gender]
    );

    if (!premiumRows || premiumRows.length === 0) {
      return 0;
    }

    const annualPremium = parseFloat(premiumRows[0].annual_premium);

    // 단기요율 조회
    let shortTermRate = 100.0;
    if (periodDays < 365) {
      const [rateRows] = await pool.execute<any[]>(
        `SELECT rate_percentage
         FROM short_term_rates 
         WHERE insurance_type = ? 
           AND period_days >= ? 
           AND is_active = 1
         ORDER BY period_days ASC 
         LIMIT 1`,
        [insuranceType, periodDays]
      );

      if (rateRows && rateRows.length > 0) {
        shortTermRate = parseFloat(rateRows[0].rate_percentage);
      }
    }

    // 최종 보험료 계산: 십원단위 절사
    const calculatedPremium = annualPremium * (shortTermRate / 100);
    const finalPremium = Math.floor(calculatedPremium / 10) * 10;

    return finalPremium;
  } catch (error) {
    console.error('보험료 계산 오류:', error);
    return 0;
  }
};

// product_cd를 보험종류로 변환
export const getInsuranceType = (productCd: string): string => {
  // product_cd에 따라 보험종류 판단 (예: 'domestic' -> '국내여행보험')
  if (productCd.includes('domestic') || productCd.includes('국내')) {
    return '국내여행보험';
  } else if (productCd.includes('long-term') || productCd.includes('장기') || 
             productCd.includes('study') || productCd.includes('working') ||
             productCd.includes('business')) {
    return '장기체류보험';
  } else if (productCd.includes('overseas') || productCd.includes('해외')) {
    return '해외여행보험';
  }
  return '국내여행보험'; // 기본값
};

// 보험종류에 따라 약관 PDF 파일명 반환
const getTermsPdfFileName = (insuranceType: string): string => {
  switch (insuranceType) {
    case '국내여행보험':
      return 'ACE손해_국내여행보험약관.pdf';
    case '해외여행보험':
      return 'ACE손해_해외여행보험약관.pdf';
    case '장기체류보험':
    case '유학/어학연수':
    case '워킹홀리데이':
    case '해외출장/주재원/교환교수':
      return '해외장기체류보험_약관.pdf';
    default:
      return 'ACE손해_국내여행보험약관.pdf'; // 기본값
  }
};

// 견적서 이메일 발송
export const sendEstimateEmail = async (data: EstimateEmailData): Promise<{ success: boolean; message: string }> => {
  try {
    const transporter = createTransporter();

    // 이메일 제목
    const subject = `[투어밸리] 여행자보험 견적서 - ${data.requestNumber}`;

    // 프론트엔드 URL
    const frontendUrl = process.env.FRONTEND_URL || 'https://www.bzvalley.net';

    // 현재 날짜/시간 (견적일자)
    const now = new Date();
    const estimateDate = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // 보험종류
    const insuranceType = getInsuranceType(data.productCd);

    // 약관 PDF 파일명
    const termsPdfFileName = getTermsPdfFileName(insuranceType);
    const termsPdfUrl = `${frontendUrl}/pdf/${encodeURIComponent(termsPdfFileName)}`;

    // 보험기간 포맷팅
    const startDateFormatted = data.startDate.replace(/-/g, '.');
    const endDateFormatted = data.endDate.replace(/-/g, '.');
    const insurancePeriod = `${startDateFormatted} ${data.startHour}시 ~ ${endDateFormatted} ${data.endHour}시`;

    // 피보험자별 보험료 계산 및 플랜 결정
    const participantRows: Array<{
      sequence: number;
      gender: string;
      birthDate: string;
      planType: string;
      premium: number;
    }> = [];

    let totalPremium = 0;

    // 기본 플랜명 (실속플랜)
    const defaultPlanType = '실속플랜';

    for (const participant of data.participants) {
      const age = calculateAge(participant.birth_date);
      const planType = age < 15 ? '어린이플랜' : defaultPlanType;
      const premium = await calculatePremium(
        insuranceType,
        age,
        participant.gender === '남자' ? '남자' : '여자',
        planType,
        data.startDate,
        data.endDate
      );

      participantRows.push({
        sequence: participant.sequence,
        gender: participant.gender === '남자' ? '남' : '여',
        birthDate: participant.birth_date.substring(2), // YYYYMMDD -> YYMMDD
        planType: planType,
        premium: premium,
      });

      totalPremium += premium;
    }

    // 보험료 포맷팅 (천단위 콤마, 원 표시)
    const formatPremium = (premium: number): string => {
      if (premium === 0) return '0원';
      return `${premium.toLocaleString()}원`;
    };

    // 피보험자 테이블 행 생성 (10개 컬럼 구조: 5개씩 2열)
    const participantTableRows: string[] = [];
    
    // 최대 5명까지 첫 번째 열에 표시, 나머지는 두 번째 열에 표시
    const firstColumnParticipants = participantRows.slice(0, 5);
    const secondColumnParticipants = participantRows.slice(5, 10);

    // 첫 번째 행: 첫 번째 열의 피보험자들
    if (firstColumnParticipants.length > 0) {
      const firstRow = firstColumnParticipants.map(p => `
        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.sequence}</td>
        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.gender}</td>
        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.birthDate}</td>
        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.planType}</td>
        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; border-right: solid 1px #d8d8d8!important;">${formatPremium(p.premium)}</td>
      `).join('');

      // 두 번째 열이 있으면 추가, 없으면 빈 셀
      const secondRowCells = secondColumnParticipants.length > 0 
        ? secondColumnParticipants.map(p => `
          <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.sequence}</td>
          <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.gender}</td>
          <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.birthDate}</td>
          <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${p.planType}</td>
          <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;">${formatPremium(p.premium)}</td>
        `).join('')
        : '<td></td><td></td><td></td><td></td><td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px;"></td>';

      participantTableRows.push(`<tr>${firstRow}${secondRowCells}</tr>`);
    }

    // 총 인원 및 합계 보험료 행
    const totalRow = `
      <tr>
        <td colspan="2" style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; letter-spacing: -1.2px; font-size: 15px; text-align: left; padding-left: 21px; background: #feffcc;">총인원</td>
        <td colspan="3" style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; letter-spacing: -1.2px; font-size: 21px!important; font-weight: 900; text-align: right; padding-right: 22px; border-right: solid 1px #d8d8d8;background: #feffcc;">${data.tourNum}명</td>
        <td colspan="2" style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; letter-spacing: -1.2px; font-size: 15px; text-align: left; padding-left: 21px; background: #feffcc;">합계보험료</td>
        <td colspan="3" style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; vertical-align: middle; font-family:Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; letter-spacing: -1.2px; font-size: 21px!important; font-weight: 900; text-align: right; padding-right: 22px; background: #feffcc; color: #f01d1d;">${formatPremium(totalPremium)}</td>
      </tr>
    `;

    // 이메일 이미지 URL (프론트엔드 URL 사용)
    const mailImageUrl = frontendUrl.replace(/\/$/, '');

    // 이메일 본문 (HTML) - test.html 구조 사용
    const htmlContent = `
      <div style="position: relative; display: block; width: 100%; text-align: center; padding: 30px 30px;">
        <section style="position: relative; width: 700px; text-align: center; margin: 0 auto;">
          <table align="center" cellpadding="0" cellspacing="0" border="0" width="700">
            <tbody>
              <tr>
                <td align="left" width="20%" style="padding:0 0 0 3px;">
                  <a href="${frontendUrl}" target="_blank" title="새창열림" rel="noreferrer noopener">
                    <img src="${mailImageUrl}/images/logo.png" border="0" alt="투어밸리" width="128" height="36" loading="lazy">
                  </a>
                </td>
                <td align="right" width="80%" style="padding:19px 4px 0 0;">
                  <img src="${mailImageUrl}/images/2023_Toptxt.png" border="0" alt="간편하고 똑똑한 여행자보험" width="175" height="17" loading="lazy">
                </td>
              </tr>
              <tr>
                <td width="100%" colspan="2" style="padding:5px 0 0 0;">
                  <img src="${mailImageUrl}/images/2023_bar01.png" border="0" alt="여행자보험 견적서 " width="700" height="71" loading="lazy">
                </td>
              </tr>
            </tbody>
          </table>
          <!--- - - - - - - - - - - - - - - - - - - - - - - - - - - 상단 내용 - - - - - - - - - - - - - - - - - - - - - - - - - - - -->
          <table align="center" cellpadding="0" cellspacing="0" border="0" width="700">
            <tbody>
              <tr>
                <td align="left" width="497" style="padding:28px 0 0 11px; vertical-align: top;">
                  <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 15px; color: #555555; text-align: left; line-height: 147%; letter-spacing: -1px; display: inline-block;">
                    안녕하세요. 고객님!<br>
                    <span style="color:#000000;"><b>간편하고 똑똑한 여행자보험</b></span><br>
                    투어밸리를 이용해 주셔서 감사드립니다.<br>
                    고객님의 안전여행과 함께 하겠습니다.<br>
                  </span>
                  <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 15px; color: #555555; text-align: left; line-height: 147%; letter-spacing: -1px; display: inline-block; padding-top:16px;">
                    견적서 출력하기를 클릭하시면 견적서를 출력하여 사용할 수 있습니다.<br>
                    알아두세요!<br>
                    보험료는 견적일자를 기준으로 산출됩니다.<br>
                    견적일자와 가입일자가 다른 경우 피보험자의 <span style="color: #1800ff;"><b>보험나이</b></span> 변경으로 인해<br>
                    보험료가 다소간 차이가 날 수 있습니다.<br>
                  </span>
                </td>
                <td align="right" width="203" style="padding:38px 2px 0 12px;">
                  <img src="${mailImageUrl}/images/202306_img01.png" alt="간편하고 똑똑한 여행자보험" width="194" height="184" border="0" loading="lazy">
                </td>
              </tr>
            </tbody>
          </table>

          <!--- - - - - - - - - - - - - - - - - - - - - - - - - - - 견적서출력 약관다운로드 - - - - - - - - - - - - - - - - - - - - - -->
          <table align="center" cellpadding="0" cellspacing="0" border="0" width="700" height="138" style="position: relative; width: 100%; border: 1px solid #d7d7d7; margin: 40px 0 65px 0;">
            <tbody>
              <tr>
                <td width="350" style="width: 33.3%; border-right: solid 1px #d7d7d7!important;">
                  <table align="center" class="" cellpadding="0" cellspacing="0" border="0" width="350">
                    <tbody>
                      <tr>
                        <td align="center">
                          <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 15px; color: #555555; text-align: center; line-height: 147%; letter-spacing: -1.4px; padding: 29px 0 12px; display: block;">견적서를 다운로드할 수 있습니다.</span>
                        </td>
                      </tr>
                      <tr>
                        <td align="center">
                          <span style="position:relative;display:block;text-align:center">
                            <a href="${frontendUrl}/estimate/print?request=${data.requestNumber}" target="_blank" style="display:inline-block;cursor:pointer;box-sizing:border-box;color: #1878f3!important;background-color: #e8f3fe;height: 45px;border-radius: 5px; font-family: noto sans kr, sans-serif,malgun gothic,맑은 고딕; font-size: 15px;font-weight: 900;padding-top: 12px;width: 190px;text-align:center;margin-bottom: 28px;letter-spacing: -1px;text-decoration: none;" rel="noreferrer noopener">
                              견적서 출력하기
                              <span style="background: url(${mailImageUrl}/images/2023_download.png) no-repeat right 0px;width:20px;height: 16px;background-size:100%;display: inline-block;vertical-align: middle;margin: 0 0 2px 6px;"></span>
                            </a>
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
                <td width="350">
                  <table align="center" class="" cellpadding="0" cellspacing="0" border="0" width="350">
                    <tbody>
                      <tr>
                        <td align="center">
                          <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 15px; color: #555555; text-align: center; line-height: 147%; letter-spacing: -1.4px; padding: 29px 0 12px; display: block;">약관을 다운로드할 수 있습니다.</span>
                        </td>
                      </tr>
                      <tr>
                        <td align="center">
                          <span style="position:relative;display:block;text-align:center">
                            <a href="${termsPdfUrl}" style="display:inline-block;cursor:pointer;box-sizing:border-box;color: #1878f3!important;background-color: #e8f3fe;height: 45px;border-radius: 5px; font-family: noto sans kr, sans-serif,malgun gothic,맑은 고딕; font-size: 15px;font-weight: 900;padding-top: 12px;width: 190px;text-align:center;margin-bottom: 28px;letter-spacing: -1px;text-decoration: none;" rel="noreferrer noopener" target="_blank">
                              약관 다운로드
                              <span style="background: url(${mailImageUrl}/images/2023_download.png) no-repeat right 0px;width:20px;height: 16px;background-size:100%;display: inline-block;vertical-align: middle;margin: 0 0 2px 6px;"></span>
                            </a>
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>
          
          <!--- - - - - - - - - - - - - - - - - - - - - - - - - - - 계약 기본정보 - - - - - - - - - - - - - - - - - - - - - -->
          <table align="center" class="" cellpadding="0" cellspacing="0" border="0" width="700">
            <tbody>
              <tr>
                <td>
                  <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-weight:bold; font-size: 23px; color: #202020; letter-spacing: -1.4px; text-align: left; display: inline-block; width: 100%; padding: 0 0 13px 0;">여행자보험 견적</span>
                </td>
              </tr>
              <tr>
                <td>
                  <table style="width: 100%; border: 0; border-collapse: collapse; table-layout: fixed; border-spacing: 0;" border="1" cellspacing="0">
                    <caption></caption>
                    <colgroup>
                      <col width="110"><col width="210"><col width="110"><col width="280">
                    </colgroup>
                    <tbody>
                      <tr>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; border-top: 2px solid #000!important; background: #eff7fe;">견적일자</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; border-top: 2px solid #000!important;">${estimateDate}</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; border-top: 2px solid #000!important; background: #eff7fe;">보험종류</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; border-top: 2px solid #000!important;">${insuranceType}</td>
                      </tr>
                      <tr>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; background: #eff7fe;">고 객 명</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box;">${data.contractorName}</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; background: #eff7fe;">보험기간</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box;">${insurancePeriod}</td>
                      </tr>
                      <tr>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box;background: #eff7fe;">인     원</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box;">${data.tourNum}명</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; background: #eff7fe;">합계보험료</td>
                        <td style="position: relative; padding: 16px 17px 15px 18px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 15px; text-align: left; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box;">${formatPremium(totalPremium)}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 14px; color: #1800ff; letter-spacing: -1px; text-align: left; display: inline-block; padding: 15px 0 0 0; vertical-align: bottom; width: 100%;">
                  ※ 본 견적서의 보험료는 <span style="color: #f01d1d;"><b>견적일자 기준</b></span>입니다. 여행자보험은 가입일자를 기준으로 보험나이를 산정하므로 견적일자와<br>&nbsp;&nbsp;&nbsp;가입일자가 차이가 나는 경우 보험료가 달라질 수 있습니다.
                </td>
              </tr>
            </tbody>
          </table>

          <table align="center" class="" cellpadding="0" cellspacing="0" border="0" width="700" style="display: ;">
            <tbody>
              <tr>
                <td style="position: relative; display: inline-block; text-align: left; width: 100%;">
                  <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-weight:bold; font-size: 21px; color: #202020; letter-spacing: -1.4px; text-align: left; display: inline-block; padding: 70px 0 13px 0;">가입대상자(피보험자)별 보험료</span>
                </td>
              </tr>
              <tr>
                <td>
                  <table style="width: 100%; border: 0; border-collapse: collapse; table-layout: fixed;" border="1" cellspacing="0">
                    <caption></caption>
                    <colgroup>
                      <col width="10%"><col width="8%"><col width="10%"><col width="11%"><col width="11%"><col width="10%"><col width="8%"><col width="10%"><col width="11%"><col width="11%">
                    </colgroup>
                    <tbody>
                      <tr>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">가입대상자</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">성별</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">생년월일</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">플랜명</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important; border-right: solid 1px #d8d8d8!important;">보험료</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">가입대상자</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">성별</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">생년월일</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">플랜명</td>
                        <td style="position: relative; padding: 13px 0px 14px 0px; border: 0; border-bottom: solid 1px #d8d8d8; font-size: 13px; vertical-align: middle; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; line-height: 132%; box-sizing: border-box; text-align: center; letter-spacing: -1.2px; background: #f5f5f5; border-top: 2px solid #000!important;">보험료</td>
                      </tr>
                      ${participantTableRows.join('')}
                      ${totalRow}
                    </tbody>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- 알아두세요 -->
          <table width="700px" cellpadding="0" cellspacing="0" border="0" style="position: relative; display: inline-block; width: 100%; border: 1px solid #e6e8ed; margin: 40px 0 15px 0; padding: 22px 14px 21px 22px;border-collapse: collapse; border-spacing: 0;">
            <tbody>
              <tr>
                <td colspan="2" style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 16px; color: #555; text-align: left; line-height: 120%; letter-spacing: -1px; padding-bottom: 3px;">※ 알아두세요.</td>
              </tr>
              <tr style="width: 100%; position: relative; display: inline-flex; justify-content: flex-start;">
                <td style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; display: inline-block; font-size: 14px; color: #555; text-align: left; line-height: 150%; letter-spacing: -0.8px; width: fit-content;">1.&nbsp;</td>
                <td style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; display: inline-block; font-size: 14px; color: #555; text-align: left; line-height: 150%; letter-spacing: -0.8px; width: fit-content;">상법 제732조에 따라 15세 미만의 경우 사망에 대해서는 보장하지않습니다.(후유장해)</td>
              </tr>
              <tr style="width: 100%; position: relative; display: inline-flex; justify-content: flex-start;">
                <td style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; display: inline-block; font-size: 14px; color: #555; text-align: left; line-height: 150%; letter-spacing: -0.8px; width: fit-content;">2.&nbsp;</td>
                <td style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; display: inline-block; font-size: 14px; color: #555; text-align: left; line-height: 150%; letter-spacing: -0.8px; width: fit-content;">(비례보상) 여행 중 실손의료비, 배상책임 및 휴대품손해 특별약관의 경우 보험금을 지급할 다수계약이 체결되어 있는 경우에는 약관에 따라 실손 비례 보상합니다.</td>
              </tr>
              <tr style="width: 100%; position: relative; display: inline-flex; justify-content: flex-start;">
                <td style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; display: inline-block; font-size: 14px; color: #555; text-align: left; line-height: 150%; letter-spacing: -0.8px; width: fit-content;">3.&nbsp;</td>
                <td style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; display: inline-block; font-size: 14px; color: #555; text-align: left; line-height: 150%; letter-spacing: -0.8px; width: fit-content;">가입 전 알아두실 사항 및 보장내용에 관한 자세한 사항은 해당약관을 참조하시기 바랍니다.</td>
              </tr>
            </tbody>
          </table>

          <table align="center" cellpadding="0" cellspacing="0" border="0" width="700">
            <tbody>
              <tr>
                <td width="100%" colspan="2" style="padding:45px 0 0 0;">
                  <img src="${mailImageUrl}/images/202306_img03.png" border="0" alt="안전여행의 동반자! 투어밸리가 함께 하겠습니다. " width="700" height="320" loading="lazy">
                </td>
              </tr>
            </tbody>
          </table>
          <table align="center" cellpadding="0" cellspacing="0" border="0" width="700" style="position:relative;display: inline-block;box-sizing:border-box;background:#eee;padding: 28px 10px 28px 15px;margin: 5px 0 35px 0; font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕;">
            <tbody>
              <tr>
                <td align="left" width="20%" style="padding:0 0 0 15px;">
                  <img src="${mailImageUrl}/images/2023_bottomlogo.png" border="0" alt="투어밸리" width="90" height="25" loading="lazy">
                </td>
                <td width="80%">
                  <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 13px;color: #999;text-align:left;line-height: 140%;letter-spacing: -0.7px;padding-top: 1px;display:block;">㈜빨주노초파남보  대표 한상윤  사업자번호 256-81-03026   보험대리점등록번호 제2022120036호</span>
                  <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 13px;color: #999;text-align:left;line-height: 140%;letter-spacing: -0.7px;padding-top: 1px;display:block;">고객센터 1599-2541</span>
                  <span style="font-family: Noto Sans KR, sans-serif,Malgun Gothic,맑은 고딕; font-size: 13px;color: #999;text-align:left;line-height: 140%;letter-spacing: -0.7px;padding-top: 1px;display:block;">서울특별시 중구 을지로11길15 동화빌딩 603호 팩스 02-2261-0098  tourmaster@insvalley.com</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    `;

    // 이메일 발송
    const mailOptions = {
      from: `"투어밸리" <tourvalley@tourvalley.net>`,
      to: data.contractorEmail,
      subject: subject,
      html: htmlContent,
    };

    await transporter.sendMail(mailOptions);

    return {
      success: true,
      message: '견적서가 성공적으로 발송되었습니다.',
    };
  } catch (error) {
    console.error('이메일 발송 오류:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : '이메일 발송에 실패했습니다.',
    };
  }
};

