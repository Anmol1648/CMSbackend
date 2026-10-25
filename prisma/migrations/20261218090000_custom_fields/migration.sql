-- AlterTable
ALTER TABLE "staff" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}';

