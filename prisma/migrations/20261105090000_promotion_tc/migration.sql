-- AlterTable
ALTER TABLE "classes" ADD COLUMN     "next_class_id" UUID;

-- CreateTable
CREATE TABLE "student_promotions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "from_year_id" UUID NOT NULL,
    "to_year_id" UUID,
    "from_section_id" UUID NOT NULL,
    "to_section_id" UUID,
    "outcome" TEXT NOT NULL,
    "carried_adjustment_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "carried_amount" INTEGER NOT NULL DEFAULT 0,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "student_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_certificates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "tc_no" TEXT,
    "application_date" DATE NOT NULL,
    "leaving_date" DATE NOT NULL,
    "reason_id" UUID,
    "last_class" TEXT,
    "result" TEXT,
    "conduct" TEXT NOT NULL DEFAULT 'Good',
    "remarks" TEXT,
    "clearances" JSONB NOT NULL DEFAULT '[]',
    "requested_by" UUID,
    "issued_by" UUID,
    "issued_at" TIMESTAMPTZ(6),
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "transfer_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_promotions_tenant_id_from_year_id_idx" ON "student_promotions"("tenant_id", "from_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_promotions_student_id_from_year_id_key" ON "student_promotions"("student_id", "from_year_id");

-- CreateIndex
CREATE INDEX "transfer_certificates_tenant_id_status_idx" ON "transfer_certificates"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_certificates_tenant_id_tc_no_key" ON "transfer_certificates"("tenant_id", "tc_no");

-- AddForeignKey
ALTER TABLE "student_promotions" ADD CONSTRAINT "student_promotions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_promotions" ADD CONSTRAINT "student_promotions_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_certificates" ADD CONSTRAINT "transfer_certificates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_certificates" ADD CONSTRAINT "transfer_certificates_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
