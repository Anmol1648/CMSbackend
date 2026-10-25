-- AlterTable
ALTER TABLE "complaints" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "enquiries" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "staff_leaves" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "visits" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}';

