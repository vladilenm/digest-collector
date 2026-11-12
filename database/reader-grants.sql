-- Apply as the digest schema owner with psql -v reader_role=your_reader_role.
-- This role receives only the published consumer view, never canonical/private tables.
GRANT USAGE ON SCHEMA digest TO :"reader_role";
GRANT SELECT ON TABLE digest.newsletter_issue_source_v1 TO :"reader_role";
