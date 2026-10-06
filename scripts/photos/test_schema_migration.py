"""Verify cleanup preserves existing data and rejects an unsafe removal merge."""
import sqlite3
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[2] / 'services/photo-gallery/migrations'
CLEANUP = (MIGRATIONS / '0006_simplify_schema.sql').read_text()

class SchemaMigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        for path in sorted(MIGRATIONS.glob('*.sql')):
            if path.name < '0006':
                self.db.executescript(path.read_text())
        self.db.executescript("""
            INSERT INTO accounts VALUES('a','person@example.org','hash','viewer',1,10,NULL);
            INSERT INTO photos VALUES('p','Admin','photo.jpg',7,'quarantined','thumb','preview','full',100,80,10,20,'operation');
            INSERT INTO photo_variants VALUES('p','full','original.jpg',100,80,100,'digest','image/jpeg');
            INSERT INTO sessions VALUES('session','a','csrf',10,500,'v1',NULL);
            INSERT INTO code_challenges VALUES('code','a','person@example.org','hash','codehash','fr',10,500,20,2,NULL,'ip');
            INSERT INTO download_requests VALUES('download','a','p',7,'full',10);
            INSERT INTO daily_aggregates VALUES('2026-10-06','p',8,4,3,1);
            INSERT INTO removal_cases VALUES('stable-case','p','a','reason','dismissed',7,0,10,20,'operation');
            INSERT INTO removal_reports VALUES('report','stable-case','p','a','reason','request','dismissed',7,10,20);
            INSERT INTO moderation_audit VALUES('audit','access-subject','restore','stable-case','p','reason',7,20);
        """)

    def tearDown(self):
        self.db.close()

    def test_retains_records_and_stable_links(self):
        self.db.executescript('BEGIN;\n' + CLEANUP + '\nCOMMIT;')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.db.execute("INSERT INTO licence_versions VALUES('v1','[]','[]',1,10)")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE licence_versions SET en_json='[1]' WHERE version='v1'")
        self.db.execute("UPDATE licence_versions SET current=0 WHERE version='v1'")
        self.assertEqual(self.db.execute('SELECT * FROM removal_requests').fetchone(),
                         ('stable-case','p','a','reason','request','dismissed',7,10,20,20,'operation'))
        self.assertEqual(self.db.execute('SELECT status,version,moderation_operation_id FROM photos').fetchone(), ('quarantined',7,'operation'))
        self.assertEqual(self.db.execute('SELECT object_key,sha256 FROM photo_variants').fetchone(), ('original.jpg','digest'))
        self.assertEqual(self.db.execute('SELECT opens,downloads FROM daily_aggregates').fetchone(), (8,4))
        self.assertEqual(self.db.execute('SELECT actor_subject,case_id FROM moderation_audit').fetchone(), ('access-subject','stable-case'))
        self.assertEqual(self.db.execute('SELECT email_hash,code_hash,attempts FROM code_challenges').fetchone(), ('hash','codehash',2))
        self.assertEqual(self.db.execute('SELECT token_hash,csrf_hash,licence_version FROM sessions').fetchone(), ('session','csrf','v1'))
        self.assertEqual(self.db.execute('SELECT request_id,account_id,format FROM download_requests').fetchone(), ('download','a','full'))
        self.assertEqual(self.db.execute('SELECT email_hash,active FROM accounts').fetchone(), ('hash',1))
        self.db.execute("INSERT INTO removal_requests(id,photo_id,requester_account_id,explanation,request_id,status,photo_version,created_at,updated_at) VALUES('new','p','a','reason','new-request','pending',8,30,30)")
        self.assertEqual(self.db.execute('SELECT version,status FROM photos').fetchone(), (8,'quarantined'))
        indexes = {row[1] for row in self.db.execute("PRAGMA index_list('accounts')")}
        self.assertNotIn('accounts_email_hash_idx', indexes)
        plan = str(self.db.execute("EXPLAIN QUERY PLAN SELECT id FROM accounts WHERE email_hash='hash'").fetchall())
        self.assertIn('INDEX', plan)

    def test_aborts_instead_of_discarding_multiple_reports(self):
        self.db.execute("INSERT INTO removal_reports VALUES('report-2','stable-case','p','a','second reason','request-2','dismissed',7,10,20)")
        self.db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.executescript('BEGIN;\n' + CLEANUP + '\nCOMMIT;')
        self.db.rollback()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM removal_reports').fetchone()[0], 2)
        self.assertIsNotNone(self.db.execute("SELECT role FROM accounts").fetchone())
        self.assertIsNone(self.db.execute("SELECT name FROM sqlite_master WHERE name='removal_requests'").fetchone())

if __name__ == '__main__':
    unittest.main()
