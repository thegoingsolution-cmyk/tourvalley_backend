# 환경 변수 설정 가이드

## 백엔드 .env 파일 설정

`b2c/home/b2c/b2c_bzvalley_backend/.env` 파일을 생성하고 아래 내용을 추가하세요.

```env
# 서버 설정
PORT=4000
NODE_ENV=development

# 데이터베이스 설정
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name

# CORS 설정
CORS_ORIGIN=http://localhost:3000

# 나이스페이먼츠 설정
NICEPAY_CLIENT_KEY=R2_f931ac15a19b443282e7ea9d0263506a
NICEPAY_SECRET_KEY=26dfd98737894b63ad2761bba56de241

# 네이버페이 설정
NAVER_PAY_CLIENT_ID=HN3GGCMDdTgGUfl0kFCo
NAVER_PAY_CLIENT_SECRET=your_naverpay_client_secret  # 실제 시크릿 키로 변경 필요
NAVER_PAY_CHAIN_ID=Y1dub1pDaDgyM0w
NAVER_PAY_ENV=dev  # dev 또는 production

# 카카오페이 설정 (계정 발급 후 추가)
# KAKAOPAY_ADMIN_KEY=your_kakaopay_admin_key
# KAKAOPAY_CID=your_kakaopay_cid

# 프론트엔드 URL
FRONTEND_URL=http://localhost:3000

# Gmail 이메일 발송 설정
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-app-password
```

## Gmail 앱 비밀번호 설정 방법

1. Google 계정 설정으로 이동: https://myaccount.google.com/
2. 보안 탭 선택
3. 2단계 인증이 활성화되어 있어야 합니다
4. "앱 비밀번호" 섹션으로 이동
5. "앱 선택"에서 "메일" 선택
6. "기기 선택"에서 "기타(맞춤 이름)" 선택하고 "투어밸리" 입력
7. 생성된 16자리 앱 비밀번호를 복사하여 `GMAIL_APP_PASSWORD`에 입력
```

## 프론트엔드 .env.local 파일 설정

`b2c/home/b2c/b2c_bzvalley_front/.env.local` 파일을 생성하고 아래 내용을 추가하세요.

```env
# 백엔드 API URL
NEXT_PUBLIC_API_URL=http://localhost:4000
```

## 결제 모듈 연동 상태

### ✅ 나이스페이먼츠
- 클라이언트 키: `R2_f931ac15a19b443282e7ea9d0263506a`
- 시크릿 키: `26dfd98737894b63ad2761bba56de241`
- 상태: 구현 완료

### ⏳ 네이버페이
- 상태: 계정 발급 중
- 구현: 준비 중

### ⏳ 카카오페이
- 상태: 계정 발급 중
- 구현: 준비 중

## 주의사항

1. `.env` 파일은 절대 Git에 커밋하지 마세요. (`.gitignore`에 포함되어 있어야 합니다)
2. 프로덕션 환경에서는 실제 키 값으로 변경하세요.
3. 나이스페이먼츠는 테스트 환경과 운영 환경의 키가 다를 수 있습니다.

