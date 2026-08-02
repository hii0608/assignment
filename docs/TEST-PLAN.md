# TEST-PLAN.md — 테스트 계획

원칙: 각 테스트는 "요구사항 또는 설계 결정 하나"를 검증한다.
계층별 역할 — 유닛(비즈니스 규칙, 빠름) / e2e(HTTP 계약) / 통합(스케줄러·동시성).
동시성과 상태 머신은 이 시스템의 최대 리스크 영역이므로 가장 두텁게 검증한다.

## 1. 유닛 테스트 — JobsService (Repository 모킹)

### 생성/조회
- [ ] 생성 시 기본값: status=pending, attempts=0, id/createdAt 자동 부여
- [ ] 존재하지 않는 id 조회 → NotFoundException

### 상태 전이 (전이 표 전수 검증)
- [ ] 허용 전이 6종 각각 성공: p→pr, pr→c, pr→p(재시도), pr→f, p→cancelled, f→p
- [ ] 거부 전이 대표 케이스 → ConflictException(409):
  - [ ] completed → pending (최종 상태 부활 금지)
  - [ ] cancelled → pending
  - [ ] pending → completed (처리 건너뛰기 금지)
  - [ ] 사용자의 → processing 직접 전이 (claiming은 워커 전용)
  - [ ] processing → cancelled (실행 중 취소 거부)
- [ ] failed → pending 수동 재시도 시 attempts=0 리셋 + failReason 초기화

### PATCH 정책
- [ ] pending에서 title/description 수정 성공
- [ ] failed에서 title 수정 성공 (상태 유지)
- [ ] failed에서 title+status=pending 동시 수정 성공 (고치고 재시도)
- [ ] processing 중 title 수정 → 409
- [ ] completed에서 title 수정 → 409

### 검색
- [ ] title 부분 일치 + 대소문자 무시
- [ ] status 정확 일치
- [ ] title+status AND 결합

## 2. e2e 테스트 — HTTP 계약 (supertest, 실제 앱 부팅 + 테스트용 임시 json 파일)

### 정상 경로
- [ ] POST /jobs → 201 + 생성된 job 반환
- [ ] GET /jobs → 200 + { data, meta } 구조 + createdAt 내림차순
- [ ] GET /jobs?page=&limit= 페이지네이션 동작 (total 정확성 포함)
- [ ] GET /jobs/search?title= → 200 + 필터링 결과
- [ ] GET /jobs/:id → 200
- [ ] PATCH /jobs/:id → 200 + 수정 반영 + updatedAt 갱신

### 라우트 순서 회귀 방지 (ARCHITECTURE.md §5의 선언 순서 규칙 검증)
- [ ] GET /jobs/search 가 :id 핸들러가 아닌 search 핸들러에 도달함
      (search 파라미터 없이 호출 → "id=search인 job 404"가 아니라 400이 오면 통과)

### 에러 계약
- [ ] POST title 누락/빈 문자열 → 400
- [ ] POST에 status 필드 포함 → 400 (whitelist 위반)
- [ ] PATCH에 attempts 등 시스템 필드 포함 → 400
- [ ] GET /jobs/search 파라미터 0개 → 400
- [ ] GET /jobs/search?status=잘못된값 → 400
- [ ] GET/PATCH 존재하지 않는 uuid → 404
- [ ] PATCH 전이 규칙 위반 → 409
- [ ] 모든 에러 응답이 통일 구조 { statusCode, error, message, timestamp, path }

### 로깅
- [ ] 요청 후 logs.txt에 JSON Lines 형식 기록 존재
- [ ] title에 개행 포함 job 생성 → 로그 줄 수가 깨지지 않음 (인젝션 방어 검증)
- [ ] PATCH 로그에 변경 필드 내역 포함 (감사 추적 검증)

## 3. 스케줄러 테스트 (타이머 모킹 또는 처리 메서드 직접 호출)

- [ ] pending job이 processing으로 claiming된 후 completed로 종료
      (핸들러 실패 여부는 주입해 결정적으로 테스트)
- [ ] 실패 시 attempts+1 후 pending 복귀 (attempts < max)
- [ ] 3회째 실패 시 failed + failReason 기록
- [ ] 배치 크기 준수: pending 10건일 때 한 주기에 5건만 처리
- [ ] 오래된 순으로 가져감 (FIFO)
- [ ] overlap 가드: isRunning=true 상태에서 주기 진입 시 스킵 + 스킵 로그
- [ ] 처리 결과가 logs.txt에 기록됨 (jobId, title, 결과)
- [ ] 부팅 시 크래시 복구 (startup sweep): processing 고아 job이 있는 상태로
      앱 부팅 → pending 복구 (attempts 불변) + scheduler.recovery 로그 기록

## 4. 동시성 테스트 (최대 리스크 영역 — 통합 테스트)

- [ ] **병렬 생성**: POST 20건 동시 발사 → jobs.json에 정확히 20건 존재 (수정 유실(lost update) 없음)
- [ ] **병렬 수정**: 서로 다른 job 10건에 동시 PATCH → 모든 수정이 반영됨
- [ ] **API vs 스케줄러 경합**: 스케줄러가 claiming하는 동안 같은 job에 PATCH →
      한쪽은 성공, 한쪽은 409, 파일은 항상 유효한 JSON (직렬화로 인해 결과가
      두 시나리오 중 하나로 수렴함을 검증)
- [ ] **파일 무결성**: 위 테스트들 후 jobs.json이 파싱 가능하고 스키마 유효

## 5. 의도적으로 제외한 것 (범위 결정)

- 다중 프로세스 동시성: 단일 프로세스 전제 (ARCHITECTURE.md §6). 전제가 바뀌면
  테스트보다 아키텍처(저장소 계층)가 먼저 바뀌어야 한다.
- 부하/성능 테스트: 운영 전제(내부 도구 규모)상 범위 외. 전환 트리거는 ARCHITECTURE.md §10.
- 확률적 실패의 통계 검증: 운에 의존하는 테스트는 불안정(flaky)해지므로, 실패 주입
  (fault injection)으로 모든 실패 경로를 결정적으로 검증하는 방식으로 대체.
