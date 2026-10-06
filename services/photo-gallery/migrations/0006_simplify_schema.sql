PRAGMA defer_foreign_keys = ON;

CREATE TABLE schema_merge_guard (valid INTEGER NOT NULL CHECK (valid=1));
INSERT INTO schema_merge_guard(valid)
SELECT CASE WHEN
  NOT EXISTS (SELECT 1 FROM removal_cases c WHERE (SELECT COUNT(*) FROM removal_reports r WHERE r.case_id=c.id) != 1)
  AND NOT EXISTS (SELECT 1 FROM removal_reports r LEFT JOIN removal_cases c ON c.id=r.case_id WHERE c.id IS NULL OR r.photo_id != c.photo_id OR r.status != c.status)
THEN 1 ELSE 0 END;
DROP TABLE schema_merge_guard;

CREATE TABLE removal_requests (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL,
  requester_account_id TEXT NOT NULL,
  explanation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','dismissed','withdrawn','duplicate')) DEFAULT 'pending',
  photo_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  moderation_operation_id TEXT,
  FOREIGN KEY (photo_id) REFERENCES photos(id),
  FOREIGN KEY (requester_account_id) REFERENCES accounts(id),
  UNIQUE (photo_id, requester_account_id, request_id)
);
INSERT INTO removal_requests(id,photo_id,requester_account_id,explanation,request_id,status,photo_version,created_at,updated_at,resolved_at,moderation_operation_id)
SELECT c.id,r.photo_id,r.requester_account_id,r.explanation,r.request_id,r.status,r.photo_version,r.created_at,c.updated_at,r.resolved_at,c.moderation_operation_id
FROM removal_reports r JOIN removal_cases c ON c.id=r.case_id;
DROP TRIGGER quarantine_photo_after_report;
DROP TABLE removal_reports;
DROP TABLE removal_cases;
CREATE INDEX removal_requests_photo_idx ON removal_requests(photo_id,status);
CREATE INDEX removal_requests_account_idx ON removal_requests(requester_account_id,created_at);
CREATE INDEX removal_requests_retention_idx ON removal_requests(status,resolved_at);
CREATE TRIGGER quarantine_photo_after_request
AFTER INSERT ON removal_requests
WHEN NEW.status='pending'
BEGIN
  UPDATE photos
  SET status=CASE WHEN status='published' THEN 'quarantined' ELSE status END,
      version=version+1,
      updated_at=strftime('%s','now')*1000
  WHERE id=NEW.photo_id;
END;

DROP INDEX accounts_email_hash_idx;
DROP INDEX download_request_binding_idx;
DROP INDEX photos_moderation_operation_idx;
ALTER TABLE accounts DROP COLUMN role;
ALTER TABLE photos DROP COLUMN thumbnail_key;
ALTER TABLE photos DROP COLUMN preview_key;
ALTER TABLE photos DROP COLUMN full_key;
ALTER TABLE daily_aggregates DROP COLUMN full_downloads;
ALTER TABLE daily_aggregates DROP COLUMN quick_downloads;
ALTER TABLE code_challenges DROP COLUMN email;
ALTER TABLE code_challenges DROP COLUMN language;
ALTER TABLE moderation_audit RENAME COLUMN actor_account_id TO actor_subject;
DROP TABLE album_visits;
PRAGMA defer_foreign_keys = OFF;

CREATE TRIGGER licence_snapshot_immutable
BEFORE UPDATE OF en_json,fr_json ON licence_versions
WHEN NEW.en_json != OLD.en_json OR NEW.fr_json != OLD.fr_json
BEGIN
  SELECT RAISE(ABORT,'Licence snapshots are immutable; use a new version');
END;
