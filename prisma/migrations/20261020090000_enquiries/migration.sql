-- CreateEnum
CREATE TYPE "TestResult" AS ENUM ('pending', 'passed', 'failed', 'not_needed');

-- CreateTable
CREATE TABLE "enquiries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enquiry_no" TEXT NOT NULL,
    "enquiry_date" DATE NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "student_first_name" TEXT NOT NULL,
    "student_last_name" TEXT,
    "date_of_birth" DATE,
    "gender_id" UUID,
    "parent_name" TEXT NOT NULL,
    "relation_id" UUID,
    "mobile" TEXT NOT NULL,
    "email" TEXT,
    "area" TEXT,
    "current_school" TEXT,
    "source_id" UUID,
    "stage_id" UUID NOT NULL,
    "assigned_to_id" UUID,
    "next_follow_up" DATE,
    "lost_reason_id" UUID,
    "registration_no" TEXT,
    "registration_date" DATE,
    "test_date" DATE,
    "test_score" TEXT,
    "test_result" "TestResult" NOT NULL DEFAULT 'not_needed',
    "remarks" TEXT,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "student_id" UUID,
    "converted_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiry_follow_ups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enquiry_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "outcome_id" UUID,
    "note" TEXT,
    "next_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "enquiry_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enquiries_tenant_id_stage_id_idx" ON "enquiries"("tenant_id", "stage_id");

-- CreateIndex
CREATE INDEX "enquiries_tenant_id_next_follow_up_idx" ON "enquiries"("tenant_id", "next_follow_up");

-- CreateIndex
CREATE INDEX "enquiries_tenant_id_mobile_idx" ON "enquiries"("tenant_id", "mobile");

-- CreateIndex
CREATE UNIQUE INDEX "enquiries_id_tenant_id_key" ON "enquiries"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "enquiry_follow_ups_tenant_id_enquiry_id_idx" ON "enquiry_follow_ups"("tenant_id", "enquiry_id");

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_class_id_tenant_id_fkey" FOREIGN KEY ("class_id", "tenant_id") REFERENCES "classes"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_gender_id_tenant_id_fkey" FOREIGN KEY ("gender_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_relation_id_tenant_id_fkey" FOREIGN KEY ("relation_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_source_id_tenant_id_fkey" FOREIGN KEY ("source_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_stage_id_tenant_id_fkey" FOREIGN KEY ("stage_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_lost_reason_id_tenant_id_fkey" FOREIGN KEY ("lost_reason_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_assigned_to_id_tenant_id_fkey" FOREIGN KEY ("assigned_to_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_follow_ups" ADD CONSTRAINT "enquiry_follow_ups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_follow_ups" ADD CONSTRAINT "enquiry_follow_ups_enquiry_id_tenant_id_fkey" FOREIGN KEY ("enquiry_id", "tenant_id") REFERENCES "enquiries"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiry_follow_ups" ADD CONSTRAINT "enquiry_follow_ups_outcome_id_tenant_id_fkey" FOREIGN KEY ("outcome_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma can't express ------------------------------------------------

CREATE UNIQUE INDEX "enquiries_no_key" ON "enquiries"("tenant_id", lower("enquiry_no"));
CREATE UNIQUE INDEX "enquiries_registration_no_key" ON "enquiries"("tenant_id", lower("registration_no")) WHERE "registration_no" IS NOT NULL;
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_names_check" CHECK ("student_first_name" = btrim("student_first_name") AND length("student_first_name") BETWEEN 1 AND 80 AND "parent_name" = btrim("parent_name") AND length("parent_name") BETWEEN 1 AND 120);
