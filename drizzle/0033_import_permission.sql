-- CSV import: owners and managers may import (Phase 1b-11).
UPDATE users SET permissions = permissions || array['import_data'] WHERE role_preset IN ('owner', 'manager') AND NOT ('import_data' = ANY(permissions));
