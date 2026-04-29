import pool from '../config/database';

export type MessageChannel = 'sms' | 'alimtalk';
export type DispatchStatus = 'success' | 'failed';

interface RecordDispatchHistoryParams {
  channel: MessageChannel;
  receiver: string;
  subject?: string | null;
  messageContent: string;
  status: DispatchStatus;
  providerMessageId?: string | null;
  providerResponse?: unknown;
  errorMessage?: string | null;
  templateCode?: string | null;
  provider?: string | null;
  sourceSystem?: string | null;
}

let tableEnsured = false;

const ensureDispatchHistoryTable = async (): Promise<void> => {
  if (tableEnsured) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sms_campaigns (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      subject VARCHAR(255) NOT NULL,
      message_content TEXT NOT NULL,
      send_type VARCHAR(20) NOT NULL,
      total_count INT NOT NULL DEFAULT 0,
      sent_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      channel VARCHAR(20) NULL,
      provider VARCHAR(30) NULL,
      template_code VARCHAR(100) NULL,
      source_system VARCHAR(50) NULL,
      INDEX idx_sms_campaigns_channel (channel),
      INDEX idx_sms_campaigns_created_at (created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sms_campaign_recipients (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      campaign_id BIGINT NOT NULL,
      phone_number VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL,
      error_message TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      provider_message_id VARCHAR(100) NULL,
      provider_response TEXT NULL,
      recipient_type VARCHAR(20) NULL,
      recipient_value VARCHAR(255) NULL,
      channel VARCHAR(20) NULL,
      template_code VARCHAR(100) NULL,
      INDEX idx_sms_campaign_id (campaign_id),
      CONSTRAINT fk_sms_campaign
        FOREIGN KEY (campaign_id)
        REFERENCES sms_campaigns(id)
        ON DELETE CASCADE
    )
  `);

  const safeAlter = async (sql: string) => {
    try {
      await pool.execute(sql);
    } catch {
    }
  };

  await safeAlter(`ALTER TABLE sms_campaigns ADD COLUMN channel VARCHAR(20) NULL`);
  await safeAlter(`ALTER TABLE sms_campaigns ADD COLUMN provider VARCHAR(30) NULL`);
  await safeAlter(`ALTER TABLE sms_campaigns ADD COLUMN template_code VARCHAR(100) NULL`);
  await safeAlter(`ALTER TABLE sms_campaigns ADD COLUMN source_system VARCHAR(50) NULL`);
  await safeAlter(`ALTER TABLE sms_campaigns ADD INDEX idx_sms_campaigns_channel (channel)`);
  await safeAlter(`ALTER TABLE sms_campaigns ADD INDEX idx_sms_campaigns_created_at (created_at)`);

  await safeAlter(`ALTER TABLE sms_campaign_recipients ADD COLUMN provider_message_id VARCHAR(100) NULL`);
  await safeAlter(`ALTER TABLE sms_campaign_recipients ADD COLUMN provider_response TEXT NULL`);
  await safeAlter(`ALTER TABLE sms_campaign_recipients ADD COLUMN recipient_type VARCHAR(20) NULL`);
  await safeAlter(`ALTER TABLE sms_campaign_recipients ADD COLUMN recipient_value VARCHAR(255) NULL`);
  await safeAlter(`ALTER TABLE sms_campaign_recipients ADD COLUMN channel VARCHAR(20) NULL`);
  await safeAlter(`ALTER TABLE sms_campaign_recipients ADD COLUMN template_code VARCHAR(100) NULL`);

  tableEnsured = true;
};

export const recordDispatchHistory = async (params: RecordDispatchHistoryParams): Promise<void> => {
  try {
    await ensureDispatchHistoryTable();
    const isSuccess = params.status === 'success';
    const subject = params.subject ?? (params.channel === 'alimtalk' ? '알림톡 발송' : '문자 발송');

    const [campaignResult] = await pool.execute<any>(
      `INSERT INTO sms_campaigns
        (subject, message_content, send_type, total_count, sent_count, failed_count, completed_at, channel, provider, template_code, source_system)
       VALUES (?, ?, 'immediate', 1, ?, ?, NOW(), ?, ?, ?, ?)`,
      [
        subject,
        params.messageContent,
        isSuccess ? 1 : 0,
        isSuccess ? 0 : 1,
        params.channel,
        params.provider ?? 'aligo',
        params.templateCode ?? null,
        params.sourceSystem ?? 'b2c_backend',
      ]
    );
    const campaignId = Number(campaignResult.insertId);
    if (!Number.isFinite(campaignId) || campaignId <= 0) return;

    await pool.execute(
      `INSERT INTO sms_campaign_recipients
        (campaign_id, phone_number, status, error_message, provider_message_id, provider_response, recipient_type, recipient_value, channel, template_code)
       VALUES (?, ?, ?, ?, ?, ?, 'phone', ?, ?, ?)`,
      [
        campaignId,
        params.receiver,
        params.status,
        params.errorMessage ?? null,
        params.providerMessageId ?? null,
        params.providerResponse ? JSON.stringify(params.providerResponse) : null,
        params.receiver,
        params.channel,
        params.templateCode ?? null,
      ]
    );
  } catch (error) {
    console.error('[sms_campaigns] 이력 저장 실패:', error);
  }
};

