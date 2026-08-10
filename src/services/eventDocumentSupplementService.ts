/**
 * 행사보험 서류보완 요청 (알림톡 UK_2218 등 → /mypage/upload)
 * 공유 DB(bzvalley) — admin_backend 발송 시 INSERT, b2c_backend 공개 API 조회/업로드
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import pool from '../config/database';

export type EventDocSupplementStatus = 'requested' | 'submitted' | 'cancelled';

export type EventDocSupplementItem = {
  id: number;
  contractId: number;
  quoteNumericId: number;
  memberId: number | null;
  requestedDocuments: string;
  status: EventDocSupplementStatus;
  requestedAt: string;
  submittedAt: string | null;
  eventName: string | null;
  companyName: string | null;
  files: Array<{
    id: number;
    originalName: string;
    url: string;
    createdAt: string;
  }>;
};

type RequestJoinRow = RowDataPacket & {
  id: number;
  contract_id: number;
  member_id: number | null;
  requested_documents: string;
  status: string;
  requested_at: Date | string;
  submitted_at: Date | string | null;
  event_name: string | null;
  contractor: string | null;
  contract_member_id: number | null;
  business_number: string | null;
};

let ensurePromise: Promise<void> | null = null;

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function getUploadBasePath(): string {
  return (
    process.env.UPLOAD_PATH ||
    (process.env.NODE_ENV === 'production'
      ? '/home/b2c/uploads'
      : path.join(process.cwd(), 'uploads'))
  );
}

function filePublicUrl(storageKey: string): string {
  const key = storageKey.replace(/^\/+/, '');
  return `/uploads/${key}`;
}

export async function ensureEventDocumentSupplementTables(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS event_document_supplement_requests (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          contract_id INT NOT NULL COMMENT 'event_contracts.id',
          member_id INT NULL,
          requested_documents TEXT NOT NULL,
          recipient_phone VARCHAR(20) DEFAULT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'requested',
          requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          submitted_at DATETIME DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_event_doc_supp_contract (contract_id, requested_at),
          KEY idx_event_doc_supp_member (member_id, status, requested_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS event_document_supplement_files (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          supplement_request_id BIGINT UNSIGNED NOT NULL,
          original_name VARCHAR(500) NOT NULL,
          storage_key VARCHAR(512) NOT NULL,
          mime_type VARCHAR(128) DEFAULT NULL,
          byte_size BIGINT UNSIGNED DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_event_doc_supp_file_req (supplement_request_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    })().catch((e) => {
      ensurePromise = null;
      throw e;
    });
  }
  await ensurePromise;
}

async function loadFilesForRequest(requestId: number): Promise<EventDocSupplementItem['files']> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, original_name, storage_key, created_at
     FROM event_document_supplement_files
     WHERE supplement_request_id = ?
     ORDER BY id ASC`,
    [requestId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    originalName: String(r.original_name),
    url: filePublicUrl(String(r.storage_key)),
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ''),
  }));
}

function mapRequestRow(row: RequestJoinRow, files: EventDocSupplementItem['files']): EventDocSupplementItem {
  return {
    id: Number(row.id),
    contractId: Number(row.contract_id),
    quoteNumericId: Number(row.contract_id),
    memberId: row.member_id != null ? Number(row.member_id) : null,
    requestedDocuments: String(row.requested_documents),
    status: row.status as EventDocSupplementStatus,
    requestedAt:
      row.requested_at instanceof Date
        ? row.requested_at.toISOString()
        : String(row.requested_at),
    submittedAt:
      row.submitted_at == null
        ? null
        : row.submitted_at instanceof Date
          ? row.submitted_at.toISOString()
          : String(row.submitted_at),
    eventName: row.event_name ? String(row.event_name) : null,
    companyName: row.contractor ? String(row.contractor) : null,
    files,
  };
}

const REQUEST_SELECT = `
  SELECT r.id, r.contract_id, r.member_id, r.requested_documents, r.status,
         r.requested_at, r.submitted_at,
         ec.event_name, ec.member_id AS contract_member_id,
         ecr.contractor, ecr.business_number
  FROM event_document_supplement_requests r
  INNER JOIN event_contracts ec ON ec.id = r.contract_id
  INNER JOIN (
    SELECT contract_id, MIN(id) AS min_id FROM event_contractors GROUP BY contract_id
  ) ecr_first ON ecr_first.contract_id = ec.id
  INNER JOIN event_contractors ecr ON ecr.id = ecr_first.min_id
`;

export async function createEventDocumentSupplementRequest(params: {
  contractId: number;
  requestedDocuments: string;
  recipientPhone?: string | null;
}): Promise<number> {
  await ensureEventDocumentSupplementTables();
  const docs = params.requestedDocuments.trim();
  if (!docs) throw new Error('요청 서류 목록이 비어 있습니다.');

  const [contractRows] = await pool.execute<RowDataPacket[]>(
    `SELECT id, member_id FROM event_contracts WHERE id = ? LIMIT 1`,
    [params.contractId],
  );
  if (!contractRows.length) throw new Error('계약을 찾을 수 없습니다.');
  const memberId =
    contractRows[0].member_id != null ? Number(contractRows[0].member_id) : null;

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO event_document_supplement_requests (
      contract_id, member_id, requested_documents, recipient_phone, status
    ) VALUES (?, ?, ?, ?, 'requested')`,
    [
      params.contractId,
      memberId,
      docs,
      params.recipientPhone ? normalizeDigits(params.recipientPhone) : null,
    ],
  );
  return result.insertId;
}

export async function getLatestEventDocSupplementForMember(
  memberId: number,
): Promise<EventDocSupplementItem | null> {
  await ensureEventDocumentSupplementTables();
  const [rows] = await pool.execute<RequestJoinRow[]>(
    `${REQUEST_SELECT}
     WHERE r.status = 'requested'
       AND (r.member_id = ? OR ec.member_id = ?)
       AND TRIM(IFNULL(ec.affiliate, '')) <> 'B2B'
     ORDER BY r.requested_at DESC
     LIMIT 1`,
    [memberId, memberId],
  );
  if (!rows.length) return null;
  const files = await loadFilesForRequest(Number(rows[0].id));
  return mapRequestRow(rows[0], files);
}

export async function getLatestEventDocSupplementForGuest(params: {
  quoteRef: string;
  businessNumber: string;
}): Promise<EventDocSupplementItem | null> {
  await ensureEventDocumentSupplementTables();
  const quoteRef = params.quoteRef.trim();
  const biz = normalizeDigits(params.businessNumber);
  if (!quoteRef || !biz) return null;

  const [rows] = await pool.execute<RequestJoinRow[]>(
    `${REQUEST_SELECT}
     WHERE r.status = 'requested'
       AND CAST(ec.id AS CHAR) = ?
       AND REPLACE(REPLACE(IFNULL(ecr.business_number, ''), '-', ''), ' ', '') = ?
       AND TRIM(IFNULL(ec.affiliate, '')) <> 'B2B'
     ORDER BY r.requested_at DESC
     LIMIT 1`,
    [quoteRef, biz],
  );
  if (!rows.length) return null;
  const files = await loadFilesForRequest(Number(rows[0].id));
  return mapRequestRow(rows[0], files);
}

async function assertMemberCanAccess(
  requestId: number,
  memberId: number,
): Promise<RequestJoinRow> {
  const [rows] = await pool.execute<RequestJoinRow[]>(
    `${REQUEST_SELECT}
     WHERE r.id = ? AND r.status = 'requested'
       AND (r.member_id = ? OR ec.member_id = ?)
       AND TRIM(IFNULL(ec.affiliate, '')) <> 'B2B'
     LIMIT 1`,
    [requestId, memberId, memberId],
  );
  if (!rows.length) {
    throw new Error('서류보완 요청을 찾을 수 없거나 제출이 완료되었습니다.');
  }
  return rows[0];
}

async function assertGuestCanAccess(
  requestId: number,
  quoteRef: string,
  businessNumber: string,
): Promise<RequestJoinRow> {
  const biz = normalizeDigits(businessNumber);
  const [rows] = await pool.execute<RequestJoinRow[]>(
    `${REQUEST_SELECT}
     WHERE r.id = ? AND r.status = 'requested'
       AND CAST(ec.id AS CHAR) = ?
       AND REPLACE(REPLACE(IFNULL(ecr.business_number, ''), '-', ''), ' ', '') = ?
       AND TRIM(IFNULL(ec.affiliate, '')) <> 'B2B'
     LIMIT 1`,
    [requestId, quoteRef.trim(), biz],
  );
  if (!rows.length) {
    throw new Error('서류보완 요청을 찾을 수 없거나 제출이 완료되었습니다.');
  }
  return rows[0];
}

export async function saveEventDocumentSupplementFiles(params: {
  requestId: number;
  files: Array<{ originalname: string; buffer: Buffer; mimetype: string; size: number }>;
  memberId?: number;
  guestQuoteRef?: string;
  guestBusinessNumber?: string;
}): Promise<EventDocSupplementItem> {
  await ensureEventDocumentSupplementTables();

  let row: RequestJoinRow;
  if (params.memberId != null && Number.isFinite(params.memberId)) {
    row = await assertMemberCanAccess(params.requestId, params.memberId);
  } else if (params.guestQuoteRef && params.guestBusinessNumber) {
    row = await assertGuestCanAccess(
      params.requestId,
      params.guestQuoteRef,
      params.guestBusinessNumber,
    );
  } else {
    throw new Error('회원 또는 비회원 인증 정보가 필요합니다.');
  }

  const uploadDir = path.join(
    getUploadBasePath(),
    'event-document-supplement',
    String(params.requestId),
  );
  fs.mkdirSync(uploadDir, { recursive: true });

  for (const file of params.files) {
    const ext =
      path.extname(file.originalname) ||
      (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
    const storedName = `${crypto.randomUUID()}${ext}`;
    const destPath = path.join(uploadDir, storedName);
    fs.writeFileSync(destPath, file.buffer);
    const storageKey = `event-document-supplement/${params.requestId}/${storedName}`;

    await pool.execute(
      `INSERT INTO event_document_supplement_files (
        supplement_request_id, original_name, storage_key, mime_type, byte_size
      ) VALUES (?, ?, ?, ?, ?)`,
      [params.requestId, file.originalname, storageKey, file.mimetype, file.size],
    );
  }

  await pool.execute(
    `UPDATE event_document_supplement_requests
     SET status = 'submitted', submitted_at = NOW()
     WHERE id = ?`,
    [params.requestId],
  );

  try {
    await pool.execute(
      `INSERT INTO event_contract_cs_history (contract_id, category, content, processed_by)
       VALUES (?, '서류제출', ?, NULL)`,
      [Number(row.contract_id), `고객 서류보완 제출 (${params.files.length}건)`],
    );
  } catch (e) {
    console.warn('[eventDocumentSupplement] cs history insert failed', e);
  }

  const files = await loadFilesForRequest(params.requestId);
  return mapRequestRow({ ...row, status: 'submitted', submitted_at: new Date() }, files);
}
