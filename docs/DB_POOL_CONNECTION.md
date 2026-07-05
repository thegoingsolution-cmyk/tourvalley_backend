# MySQL Connection Pool — 장애 대응 & 모니터링

> **대상:** `b2c_tourvalley_backend` (`pm2`: `b2c-backend`)  
> **관련 코드:** `src/config/database.ts`  
> **작업일:** 2026-07-05

---

## 1. 배경 (왜 작업했는지)

### 증상

- `b2c-backend`만 전체 API가 먹통 (로그인, 보험료 계산, 조회 등 실패)
- PM2 로그에 아래 메시지가 연속 출력

```
MySQL pool connection error: The client was disconnected by the server because of inactivity.
See wait_timeout and interactive_timeout for configuring this behavior.
```

- 가만히 두면 시간이 지나면서 회복되거나, `pm2 restart b2c-backend`로 즉시 해결됨
- `b2c-admin-backend` 등 다른 프로세스는 동일 증상 없음

### 원인 (요약)

| 구분 | 내용 |
|------|------|
| RDS | `default.mysql8.4` 파라미터 그룹, `wait_timeout` = 엔진 기본값 **28800초(8시간)** — RDS timeout 설정 문제 아님 |
| 앱 풀 | idle 연결이 RDS/MySQL 쪽에서 끊긴 뒤, 풀이 **죽은 연결을 그대로 재사용** |
| 재시도 | `inactivity` 에러가 stale 판별·재시도 대상에 **포함되지 않음** |
| 트랜잭션 | 로그인·결제·보험료 등은 `getConnection()` → `connection.execute()` 경로 — `pool.execute` 재시도만으로는 부족 |
| 무한 대기 | `queueLimit: 0` → 풀 고갈 시 요청이 **끝없이 대기** (HTTP 타임아웃까지 먹통) |

---

## 2. 적용한 변경 (`src/config/database.ts`)

### 2.1 Stale 연결 재시도

`isStaleConnectionError`에 아래 패턴 추가:

- `inactivity`
- `disconnected by the server`
- `ER_CLIENT_INTERACTION_TIMEOUT`

`pool.execute` / `pool.query` 실패 시 **1회 자동 재시도**.

### 2.2 `getConnection` ping 검증

트랜잭션 경로용:

1. 연결 획득
2. `SELECT 1` ping
3. 실패 시 `destroy()` 후 **최대 2회 재시도**

### 2.3 무한 대기 방지

| 설정 | 이전 | 이후 |
|------|------|------|
| `queueLimit` | `0` (무한) | **`50`** |
| acquire timeout | 없음 | **`10초`** (`DB_ACQUIRE_TIMEOUT_MS`) |

풀 고갈 시 요청이 영원히 hang되지 않고, 10초 후 에러로 종료.

### 2.4 idle 연결 축소

| 설정 | 이전 | 이후 |
|------|------|------|
| `maxIdle` 기본값 | `6` (limit/3) | **`3`** |
| `connectionLimit` | `20` | **`20` 유지** (1차 배포) |
| `idleTimeout` | `60_000` | `60_000` (60초) |

### 2.5 로그 레벨

idle disconnect(inactivity)는 `console.error` → **`console.warn`**.

---

## 3. 환경 변수 (선택)

`.env`에 없으면 코드 기본값 사용.

```env
# 프로세스당 풀 최대 연결 수 (현재 기본 20)
DB_CONNECTION_LIMIT=20

# idle 상태로 풀에 남겨둘 연결 수 (기본 3, connectionLimit보다 작아야 idle 정리 동작)
DB_MAX_IDLE=3

# getConnection 대기 최대 시간 ms (기본 10000)
DB_ACQUIRE_TIMEOUT_MS=10000

# 연결 대기 큐 최대 길이 (기본 50, 0=무한)
DB_QUEUE_LIMIT=50
```

### EC2 기준 RDS 연결 수 (참고)

```
b2c-backend         fork 1개  → 최대 20
b2c-admin-backend   fork 1개  → 최대 10 + bzvalley 10
────────────────────────────────────────
EC2 한 대            → RDS 최대 ~40 (micro max_connections ≈ 85)
```

---

## 4. 배포

```bash
cd b2c/home/b2c/b2c_tourvalley_backend
npm run build    # dist 빌드 사용 시
pm2 restart b2c-backend
pm2 logs b2c-backend --lines 100
```

---

## 5. 모니터링 가이드

### 5.1 정상으로 볼 수 있는 로그 (warn)

아래는 **가끔** 나와도 괜찮습니다. 풀이 idle 연결을 정리하는 과정입니다.

```
MySQL pool idle connection closed: The client was disconnected by the server because of inactivity...
MySQL stale connection detected, retrying... The client was disconnected by the server because of inactivity...
```

**확인 포인트:** 위 warn 직후에도 **브라우저/API가 정상 응답**하면 수정이 의도대로 동작 중.

### 5.2 주의 — 패턴 관찰

| 로그 / 증상 | 의미 | 조치 |
|-------------|------|------|
| `stale connection detected, retrying` **가끔** | 끊긴 연결 자동 복구 중 | 정상, 계속 관찰 |
| 위 warn **초당 여러 번 + API 실패** | 재시도로도 복구 안 됨 | §6 정보 수집 후 공유 |
| `MySQL pool acquire timeout after 10000ms` | 10초 내 연결 못 받음 (풀 고갈) | §6 + `DB_CONNECTION_LIMIT` / leak 점검 |
| `Queue limit reached` | 대기 큐 50 초과 | 트래픽 급증 또는 연결 leak 의심 |
| `MySQL pool connection error:` (**error**, inactivity 외) | 네트워크/RDS 장애 등 | §6 정보 수집 |
| `Database ping failed` | DB 자체 unreachable | RDS 상태·보안그룹·네트워크 확인 |

### 5.3 실제 장애 여부 확인 (가장 중요)

로그만 보지 말고 **아래 API가 동시에 되는지** 확인:

- 로그인
- 보험료 계산 (travel 견적)
- 계약/결제 조회

warn만 있고 API 정상 → **장애 아님**.  
warn + API 전부 실패 → **아직 문제 있음**, §6 참고.

### 5.4 유용한 PM2 / RDS 명령

```bash
# b2c-backend 로그 실시간
pm2 logs b2c-backend

# 프로세스 상태
pm2 list

# RDS 현재 연결 수 (콘솔 Summary 또는)
# SHOW STATUS LIKE 'Threads_connected';
# SHOW VARIABLES LIKE 'wait_timeout';
```

---

## 6. 추가 에러 발생 시 공유해 줄 정보

다른 에러나 먹통 재발 시 아래를 알려주면 수정에 바로 활용 가능.

1. **발생 시각** (KST)
2. **PM2 로그** — 에러 전후 30~50줄 (`pm2 logs b2c-backend --lines 50`)
3. **당시 API 상태** — 어떤 기능이 안 됐는지 (로그인 / 보험료 / 결제 등)
4. **회복 방법** — 자동 회복 vs `pm2 restart` 필요
5. **RDS 콘솔** — Summary의 **현재 연결 수**, CPU
6. **(가능하면)** `.env`의 `DB_CONNECTION_LIMIT`, `DB_MAX_IDLE` 값

에러 메시지 **전문**을 그대로 붙여주면 가장 좋음.

---

## 7. 1~2주 모니터링 후 튜닝 (예정)

증상 없이 안정적이면 현 설정 유지.

여전히 `acquire timeout` / `Queue limit reached`가 보이면:

```env
DB_CONNECTION_LIMIT=12
DB_MAX_IDLE=2
```

idle disconnect warn만 자주 보이고 API는 정상이면 **env 변경 없이** 유지해도 됨.

---

## 8. 아직 손대지 않은 것

| 항목 | 비고 |
|------|------|
| `b2c-admin-backend` | 이번 장애 대상 아님, pool 설정 변경 없음 |
| RDS 파라미터 그룹 | `wait_timeout` 8시간 default — 변경 불필요 |
| `connection.execute` 직접 호출 wrapper | `getConnection` ping + pool 재시도로 대부분 커버 |

---

## 9. 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-07-05 | 최초 작성 — stale 재시도, getConnection ping, acquire timeout, queueLimit, maxIdle 3 |
