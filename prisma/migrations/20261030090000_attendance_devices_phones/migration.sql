-- AlterTable
ALTER TABLE "staff" ADD COLUMN     "device_user_id" TEXT;

-- CreateTable
CREATE TABLE "staff_phones" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "device_hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "staff_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "serial_no" TEXT,
    "token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ(6),
    "last_punch_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "attendance_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_punches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "device_id" UUID,
    "device_user_id" TEXT NOT NULL,
    "staff_id" UUID,
    "punched_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_punches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_phones_staff_id_tenant_id_key" ON "staff_phones"("staff_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_serial_no_key" ON "attendance_devices"("serial_no");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_token_key" ON "attendance_devices"("token");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_devices_id_tenant_id_key" ON "attendance_devices"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "attendance_punches_tenant_id_punched_at_idx" ON "attendance_punches"("tenant_id", "punched_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_punches_tenant_id_device_user_id_punched_at_key" ON "attendance_punches"("tenant_id", "device_user_id", "punched_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tenant_id_device_user_id_key" ON "staff"("tenant_id", "device_user_id");

-- AddForeignKey
ALTER TABLE "staff_phones" ADD CONSTRAINT "staff_phones_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_phones" ADD CONSTRAINT "staff_phones_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_device_id_tenant_id_fkey" FOREIGN KEY ("device_id", "tenant_id") REFERENCES "attendance_devices"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_punches" ADD CONSTRAINT "attendance_punches_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;
