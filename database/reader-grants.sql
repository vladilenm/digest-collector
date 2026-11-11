-- Apply as the digest schema owner with psql -v reader_role=your_reader_role.
-- This role receives only the published consumer view, never canonical/private tables.
GRANT USAGE ON SCHEMA digest TO :"reader_role";
GRANT SELECT ON TABLE digest.published_issue_source TO :"reader_role";
