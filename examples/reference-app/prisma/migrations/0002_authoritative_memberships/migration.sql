ALTER TABLE tenant_memberships
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE review_assignments
  ADD CONSTRAINT review_assignments_reviewer_id_fkey
  FOREIGN KEY (reviewer_id) REFERENCES users(id);

ALTER TABLE review_decisions
  ADD CONSTRAINT review_decisions_reviewer_id_fkey
  FOREIGN KEY (reviewer_id) REFERENCES users(id);
