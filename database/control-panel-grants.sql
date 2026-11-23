GRANT USAGE ON SCHEMA newsletter TO :"panel_role";
GRANT SELECT ON newsletter.unisender_campaigns, newsletter.operator_requests, newsletter.sender_health TO :"panel_role";
GRANT INSERT (id,topic_id,list_id,mode,send_date,action,retry_attempt) ON newsletter.operator_requests TO :"panel_role";
GRANT SELECT ON newsletter.unisender_attempt_history TO :"panel_role";
