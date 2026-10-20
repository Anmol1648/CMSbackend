-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('working', 'relieved', 'retired', 'suspended');

-- DropForeignKey
ALTER TABLE "sections" DROP CONSTRAINT "sections_class_teacher_id_tenant_id_fkey";

-- AlterTable
ALTER TABLE "sections" DROP COLUMN "class_teacher_id",
ADD COLUMN     "class_teacher_staff_id" UUID;

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_code" TEXT NOT NULL,
    "joining_date" DATE NOT NULL,
    "first_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "last_name" TEXT,
    "date_of_birth" DATE,
    "gender_id" UUID,
    "blood_group_id" UUID,
    "religion_id" UUID,
    "caste_category_id" UUID,
    "marital_status_id" UUID,
    "mobile" TEXT,
    "email" TEXT,
    "aadhaar" TEXT,
    "pan" TEXT,
    "address_line" TEXT,
    "state_id" UUID,
    "district_id" UUID,
    "city_id" UUID,
    "pin_code" TEXT,
    "department_id" UUID,
    "designation_id" UUID,
    "staff_type_id" UUID,
    "employment_type_id" UUID,
    "teaching_post_id" UUID,
    "reports_to_id" UUID,
    "teachable_subject_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "bank_id" UUID,
    "bank_account_no" TEXT,
    "ifsc" TEXT,
    "pf_number" TEXT,
    "uan" TEXT,
    "emergency_name" TEXT,
    "emergency_phone" TEXT,
    "photo_file_id" UUID,
    "user_id" UUID,
    "status" "StaffStatus" NOT NULL DEFAULT 'working',
    "status_date" DATE,
    "relieving_reason_id" UUID,
    "status_note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_qualifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "qualification_id" UUID,
    "subject" TEXT,
    "institution" TEXT,
    "year" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_experience" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "organisation" TEXT NOT NULL,
    "role" TEXT,
    "from_date" DATE,
    "to_date" DATE,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "type_id" UUID,
    "file_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "staff_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teaching_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "teaching_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_tenant_id_status_idx" ON "staff"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "staff_id_tenant_id_key" ON "staff"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_id_tenant_id_key" ON "staff"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "staff_qualifications_tenant_id_staff_id_idx" ON "staff_qualifications"("tenant_id", "staff_id");

-- CreateIndex
CREATE INDEX "staff_experience_tenant_id_staff_id_idx" ON "staff_experience"("tenant_id", "staff_id");

-- CreateIndex
CREATE INDEX "staff_documents_tenant_id_staff_id_idx" ON "staff_documents"("tenant_id", "staff_id");

-- CreateIndex
CREATE INDEX "teaching_assignments_tenant_id_academic_year_id_staff_id_idx" ON "teaching_assignments"("tenant_id", "academic_year_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "teaching_assignments_section_id_subject_id_key" ON "teaching_assignments"("section_id", "subject_id");

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_class_teacher_staff_id_tenant_id_fkey" FOREIGN KEY ("class_teacher_staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_photo_file_id_fkey" FOREIGN KEY ("photo_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_reports_to_id_tenant_id_fkey" FOREIGN KEY ("reports_to_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_gender_id_tenant_id_fkey" FOREIGN KEY ("gender_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_blood_group_id_tenant_id_fkey" FOREIGN KEY ("blood_group_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_religion_id_tenant_id_fkey" FOREIGN KEY ("religion_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_caste_category_id_tenant_id_fkey" FOREIGN KEY ("caste_category_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_marital_status_id_tenant_id_fkey" FOREIGN KEY ("marital_status_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_state_id_tenant_id_fkey" FOREIGN KEY ("state_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_district_id_tenant_id_fkey" FOREIGN KEY ("district_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_city_id_tenant_id_fkey" FOREIGN KEY ("city_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_department_id_tenant_id_fkey" FOREIGN KEY ("department_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_designation_id_tenant_id_fkey" FOREIGN KEY ("designation_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_staff_type_id_tenant_id_fkey" FOREIGN KEY ("staff_type_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_employment_type_id_tenant_id_fkey" FOREIGN KEY ("employment_type_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_teaching_post_id_tenant_id_fkey" FOREIGN KEY ("teaching_post_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_bank_id_tenant_id_fkey" FOREIGN KEY ("bank_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_relieving_reason_id_tenant_id_fkey" FOREIGN KEY ("relieving_reason_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_qualifications" ADD CONSTRAINT "staff_qualifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_qualifications" ADD CONSTRAINT "staff_qualifications_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_qualifications" ADD CONSTRAINT "staff_qualifications_qualification_id_tenant_id_fkey" FOREIGN KEY ("qualification_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_experience" ADD CONSTRAINT "staff_experience_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_experience" ADD CONSTRAINT "staff_experience_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_documents" ADD CONSTRAINT "staff_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_documents" ADD CONSTRAINT "staff_documents_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_documents" ADD CONSTRAINT "staff_documents_type_id_tenant_id_fkey" FOREIGN KEY ("type_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_documents" ADD CONSTRAINT "staff_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaching_assignments" ADD CONSTRAINT "teaching_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaching_assignments" ADD CONSTRAINT "teaching_assignments_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaching_assignments" ADD CONSTRAINT "teaching_assignments_section_id_tenant_id_fkey" FOREIGN KEY ("section_id", "tenant_id") REFERENCES "sections"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaching_assignments" ADD CONSTRAINT "teaching_assignments_subject_id_tenant_id_fkey" FOREIGN KEY ("subject_id", "tenant_id") REFERENCES "subjects"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teaching_assignments" ADD CONSTRAINT "teaching_assignments_staff_id_tenant_id_fkey" FOREIGN KEY ("staff_id", "tenant_id") REFERENCES "staff"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rules Prisma can't express ------------------------------------------------

CREATE UNIQUE INDEX "staff_employee_code_key" ON "staff"("tenant_id", lower("employee_code"));
CREATE UNIQUE INDEX "staff_aadhaar_key" ON "staff"("tenant_id", "aadhaar") WHERE "aadhaar" IS NOT NULL;
CREATE UNIQUE INDEX "staff_pan_key" ON "staff"("tenant_id", upper("pan")) WHERE "pan" IS NOT NULL;
ALTER TABLE "staff" ADD CONSTRAINT "staff_names_check" CHECK ("first_name" = btrim("first_name") AND length("first_name") BETWEEN 1 AND 80 AND "employee_code" = btrim("employee_code") AND length("employee_code") BETWEEN 1 AND 40);
ALTER TABLE "staff" ADD CONSTRAINT "staff_reports_to_check" CHECK ("reports_to_id" IS NULL OR "reports_to_id" <> "id");
ALTER TABLE "staff_qualifications" ADD CONSTRAINT "staff_qualifications_year_check" CHECK ("year" IS NULL OR "year" BETWEEN 1950 AND 2100);
ALTER TABLE "staff_experience" ADD CONSTRAINT "staff_experience_org_check" CHECK ("organisation" = btrim("organisation") AND length("organisation") BETWEEN 1 AND 150);
