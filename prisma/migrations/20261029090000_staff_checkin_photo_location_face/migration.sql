-- AlterTable
ALTER TABLE "staff_attendance" ADD COLUMN     "approval" TEXT,
ADD COLUMN     "approval_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "check_in_accuracy" INTEGER,
ADD COLUMN     "check_in_distance" INTEGER,
ADD COLUMN     "check_in_lat" DOUBLE PRECISION,
ADD COLUMN     "check_in_lng" DOUBLE PRECISION,
ADD COLUMN     "check_in_photo_id" UUID,
ADD COLUMN     "check_out_accuracy" INTEGER,
ADD COLUMN     "check_out_distance" INTEGER,
ADD COLUMN     "check_out_lat" DOUBLE PRECISION,
ADD COLUMN     "check_out_lng" DOUBLE PRECISION,
ADD COLUMN     "check_out_photo_id" UUID,
ADD COLUMN     "decided_at" TIMESTAMPTZ(6),
ADD COLUMN     "decided_by" UUID,
ADD COLUMN     "decision_note" TEXT,
ADD COLUMN     "face_distance" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "attendance_locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "radius" INTEGER NOT NULL DEFAULT 150,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "attendance_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_faces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "descriptors" JSONB NOT NULL,
    "photo_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" TEXT NOT NULL DEFAULT 'approved',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "staff_faces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_locations_tenant_id_idx" ON "attendance_locations"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_faces_staff_id_tenant_id_key" ON "staff_faces"("staff_id", "tenant_id");

-- AddForeignKey
ALTER TABLE "attendance_locations" ADD CONSTRAINT "attendance_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_faces" ADD CONSTRAINT "staff_faces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_faces" ADD CONSTRAINT "staff_faces_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
