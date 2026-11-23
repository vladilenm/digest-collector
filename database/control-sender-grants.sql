GRANT USAGE ON SCHEMA newsletter TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON newsletter.unisender_campaigns, newsletter.sender_health TO :"runtime_role";
GRANT SELECT, UPDATE (state, result_code, updated_at) ON newsletter.operator_requests TO :"runtime_role";
