-- Apply with psql -v runtime_role=your_publisher_role to a dedicated role without legacy grants.
GRANT USAGE ON SCHEMA newsletter TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE ON TABLE newsletter.unisender_campaigns TO :"runtime_role";
