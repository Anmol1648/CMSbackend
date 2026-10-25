-- Codes a school had before (Platform console -> Change code): the old address and code still lead to it.
ALTER TABLE "tenants" ADD COLUMN "old_codes" TEXT[] DEFAULT ARRAY[]::TEXT[];
