-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('cash', 'upi', 'cheque', 'dd', 'bank_transfer', 'card', 'online');

-- CreateEnum
CREATE TYPE "ConcessionKind" AS ENUM ('percent', 'amount');

-- CreateEnum
CREATE TYPE "FeeReceiptStatus" AS ENUM ('active', 'cancelled');

-- CreateEnum
CREATE TYPE "OnlinePaymentPurpose" AS ENUM ('fees', 'registration');

-- CreateEnum
CREATE TYPE "OnlinePaymentStatus" AS ENUM ('created', 'paid', 'failed');

-- AlterTable
ALTER TABLE "enquiries" ADD COLUMN     "registration_fee" INTEGER,
ADD COLUMN     "registration_fee_mode" "PaymentMode",
ADD COLUMN     "registration_fee_ref" TEXT;

-- CreateTable
CREATE TABLE "fee_instalments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "fee_instalments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structure_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "fee_head_id" UUID NOT NULL,
    "instalment_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "fee_structure_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_concessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "gender_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "caste_category_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "category_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "class_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "fee_concessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_concession_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "concession_id" UUID NOT NULL,
    "fee_head_id" UUID NOT NULL,
    "kind" "ConcessionKind" NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "fee_concession_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_fee_concessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "concession_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "student_fee_concessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "instalment_id" UUID NOT NULL,
    "fee_head_id" UUID,
    "is_fine" BOOLEAN NOT NULL DEFAULT false,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "fee_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT,
    "bank_name" TEXT,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "status" "FeeReceiptStatus" NOT NULL DEFAULT 'active',
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    "online_payment_id" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "fee_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_receipt_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "instalment_id" UUID NOT NULL,
    "fee_head_id" UUID,
    "is_fine" BOOLEAN NOT NULL DEFAULT false,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "fee_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_gateways" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "key_id" TEXT,
    "key_secret_enc" TEXT,
    "webhook_secret_enc" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "payment_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "purpose" "OnlinePaymentPurpose" NOT NULL,
    "provider" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_ref" TEXT,
    "amount" INTEGER NOT NULL,
    "convenience_fee" INTEGER NOT NULL DEFAULT 0,
    "status" "OnlinePaymentStatus" NOT NULL DEFAULT 'created',
    "student_id" UUID,
    "enquiry_id" UUID,
    "academic_year_id" UUID,
    "allocation" JSONB NOT NULL DEFAULT '[]',
    "user_id" UUID,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(6),

    CONSTRAINT "online_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_instalments_tenant_id_academic_year_id_due_date_idx" ON "fee_instalments"("tenant_id", "academic_year_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "fee_instalments_id_tenant_id_key" ON "fee_instalments"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "fee_structure_lines_tenant_id_academic_year_id_class_id_idx" ON "fee_structure_lines"("tenant_id", "academic_year_id", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structure_lines_tenant_id_class_id_fee_head_id_instalme_key" ON "fee_structure_lines"("tenant_id", "class_id", "fee_head_id", "instalment_id");

-- CreateIndex
CREATE INDEX "fee_concessions_tenant_id_academic_year_id_idx" ON "fee_concessions"("tenant_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_concessions_id_tenant_id_key" ON "fee_concessions"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_concession_lines_concession_id_fee_head_id_key" ON "fee_concession_lines"("concession_id", "fee_head_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_fee_concessions_student_id_concession_id_key" ON "student_fee_concessions"("student_id", "concession_id");

-- CreateIndex
CREATE INDEX "fee_adjustments_tenant_id_student_id_academic_year_id_idx" ON "fee_adjustments"("tenant_id", "student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "fee_receipts_tenant_id_date_idx" ON "fee_receipts"("tenant_id", "date");

-- CreateIndex
CREATE INDEX "fee_receipts_tenant_id_student_id_idx" ON "fee_receipts"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipts_id_tenant_id_key" ON "fee_receipts"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipts_online_payment_id_tenant_id_key" ON "fee_receipts"("online_payment_id", "tenant_id");

-- CreateIndex
CREATE INDEX "fee_receipt_lines_tenant_id_receipt_id_idx" ON "fee_receipt_lines"("tenant_id", "receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateways_tenant_id_key" ON "payment_gateways"("tenant_id");

-- CreateIndex
CREATE INDEX "online_payments_tenant_id_status_idx" ON "online_payments"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_id_tenant_id_key" ON "online_payments"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_payments_provider_order_id_key" ON "online_payments"("provider", "order_id");

-- AddForeignKey
ALTER TABLE "fee_instalments" ADD CONSTRAINT "fee_instalments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_instalments" ADD CONSTRAINT "fee_instalments_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_class_id_tenant_id_fkey" FOREIGN KEY ("class_id", "tenant_id") REFERENCES "classes"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_fee_head_id_tenant_id_fkey" FOREIGN KEY ("fee_head_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_instalment_id_tenant_id_fkey" FOREIGN KEY ("instalment_id", "tenant_id") REFERENCES "fee_instalments"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concession_lines" ADD CONSTRAINT "fee_concession_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concession_lines" ADD CONSTRAINT "fee_concession_lines_concession_id_tenant_id_fkey" FOREIGN KEY ("concession_id", "tenant_id") REFERENCES "fee_concessions"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concession_lines" ADD CONSTRAINT "fee_concession_lines_fee_head_id_tenant_id_fkey" FOREIGN KEY ("fee_head_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_concessions" ADD CONSTRAINT "student_fee_concessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_concessions" ADD CONSTRAINT "student_fee_concessions_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_fee_concessions" ADD CONSTRAINT "student_fee_concessions_concession_id_tenant_id_fkey" FOREIGN KEY ("concession_id", "tenant_id") REFERENCES "fee_concessions"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_instalment_id_tenant_id_fkey" FOREIGN KEY ("instalment_id", "tenant_id") REFERENCES "fee_instalments"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_fee_head_id_tenant_id_fkey" FOREIGN KEY ("fee_head_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipts" ADD CONSTRAINT "fee_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipts" ADD CONSTRAINT "fee_receipts_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipts" ADD CONSTRAINT "fee_receipts_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipts" ADD CONSTRAINT "fee_receipts_online_payment_id_tenant_id_fkey" FOREIGN KEY ("online_payment_id", "tenant_id") REFERENCES "online_payments"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipt_lines" ADD CONSTRAINT "fee_receipt_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipt_lines" ADD CONSTRAINT "fee_receipt_lines_receipt_id_tenant_id_fkey" FOREIGN KEY ("receipt_id", "tenant_id") REFERENCES "fee_receipts"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipt_lines" ADD CONSTRAINT "fee_receipt_lines_instalment_id_tenant_id_fkey" FOREIGN KEY ("instalment_id", "tenant_id") REFERENCES "fee_instalments"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_receipt_lines" ADD CONSTRAINT "fee_receipt_lines_fee_head_id_tenant_id_fkey" FOREIGN KEY ("fee_head_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_enquiry_id_tenant_id_fkey" FOREIGN KEY ("enquiry_id", "tenant_id") REFERENCES "enquiries"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma can't express
CREATE UNIQUE INDEX "fee_receipts_tenant_receipt_no_key" ON "fee_receipts" ("tenant_id", lower("receipt_no"));
CREATE UNIQUE INDEX "fee_instalments_tenant_year_name_key" ON "fee_instalments" ("tenant_id", "academic_year_id", lower("name"));
CREATE UNIQUE INDEX "fee_concessions_tenant_year_name_key" ON "fee_concessions" ("tenant_id", "academic_year_id", lower("name"));
ALTER TABLE "fee_structure_lines" ADD CONSTRAINT "fee_structure_lines_amount_check" CHECK ("amount" >= 0);
ALTER TABLE "fee_receipts" ADD CONSTRAINT "fee_receipts_amount_check" CHECK ("amount" > 0);
ALTER TABLE "fee_receipt_lines" ADD CONSTRAINT "fee_receipt_lines_amount_check" CHECK ("amount" > 0);
ALTER TABLE "fee_receipt_lines" ADD CONSTRAINT "fee_receipt_lines_head_check" CHECK (("is_fine" AND "fee_head_id" IS NULL) OR (NOT "is_fine" AND "fee_head_id" IS NOT NULL));
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_head_check" CHECK (("is_fine" AND "fee_head_id" IS NULL) OR (NOT "is_fine" AND "fee_head_id" IS NOT NULL));
ALTER TABLE "fee_concession_lines" ADD CONSTRAINT "fee_concession_lines_value_check" CHECK ("value" >= 0 AND ("kind" <> 'percent' OR "value" <= 100));
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_amount_check" CHECK ("amount" > 0);
ALTER TABLE "online_payments" ADD CONSTRAINT "online_payments_for_check" CHECK (("purpose" = 'fees' AND "student_id" IS NOT NULL) OR ("purpose" = 'registration' AND "enquiry_id" IS NOT NULL));
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_registration_fee_check" CHECK ("registration_fee" IS NULL OR "registration_fee" >= 0);
