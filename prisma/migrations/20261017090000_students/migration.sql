-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('active', 'left', 'passed_out', 'struck_off');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_demo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "number_sequences" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "families" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardians" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "relation_id" UUID,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "occupation_id" UUID,
    "qualification_id" UUID,
    "income_range_id" UUID,
    "aadhaar" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "user_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "admission_no" TEXT NOT NULL,
    "admission_date" DATE NOT NULL,
    "admission_type_id" UUID,
    "first_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "last_name" TEXT,
    "date_of_birth" DATE,
    "gender_id" UUID,
    "blood_group_id" UUID,
    "religion_id" UUID,
    "caste_category_id" UUID,
    "mother_tongue_id" UUID,
    "nationality_id" UUID,
    "disability_id" UUID,
    "category_id" UUID,
    "aadhaar" TEXT,
    "apaar_id" TEXT,
    "pen" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "address_line" TEXT,
    "state_id" UUID,
    "district_id" UUID,
    "city_id" UUID,
    "pin_code" TEXT,
    "previous_school" TEXT,
    "previous_board_id" UUID,
    "previous_class" TEXT,
    "tc_number" TEXT,
    "medical_notes" TEXT,
    "emergency_name" TEXT,
    "emergency_phone" TEXT,
    "photo_file_id" UUID,
    "family_id" UUID,
    "user_id" UUID,
    "status" "StudentStatus" NOT NULL DEFAULT 'active',
    "status_date" DATE,
    "leaving_reason_id" UUID,
    "status_note" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrolments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "roll_number" INTEGER,
    "house_id" UUID,
    "optional_subject_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "type_id" UUID,
    "file_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "student_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "families_id_tenant_id_key" ON "families"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "guardians_tenant_id_family_id_idx" ON "guardians"("tenant_id", "family_id");

-- CreateIndex
CREATE INDEX "guardians_tenant_id_mobile_idx" ON "guardians"("tenant_id", "mobile");

-- CreateIndex
CREATE UNIQUE INDEX "guardians_user_id_tenant_id_key" ON "guardians"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "students_tenant_id_status_idx" ON "students"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "students_tenant_id_family_id_idx" ON "students"("tenant_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_id_tenant_id_key" ON "students"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_tenant_id_key" ON "students"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "enrolments_tenant_id_section_id_idx" ON "enrolments"("tenant_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_student_id_academic_year_id_key" ON "enrolments"("student_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "student_documents_tenant_id_student_id_idx" ON "student_documents"("tenant_id", "student_id");

-- AddForeignKey
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_family_id_tenant_id_fkey" FOREIGN KEY ("family_id", "tenant_id") REFERENCES "families"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_relation_id_tenant_id_fkey" FOREIGN KEY ("relation_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_occupation_id_tenant_id_fkey" FOREIGN KEY ("occupation_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_qualification_id_tenant_id_fkey" FOREIGN KEY ("qualification_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_income_range_id_tenant_id_fkey" FOREIGN KEY ("income_range_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_family_id_tenant_id_fkey" FOREIGN KEY ("family_id", "tenant_id") REFERENCES "families"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_photo_file_id_fkey" FOREIGN KEY ("photo_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_admission_type_id_tenant_id_fkey" FOREIGN KEY ("admission_type_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_gender_id_tenant_id_fkey" FOREIGN KEY ("gender_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_blood_group_id_tenant_id_fkey" FOREIGN KEY ("blood_group_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_religion_id_tenant_id_fkey" FOREIGN KEY ("religion_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_caste_category_id_tenant_id_fkey" FOREIGN KEY ("caste_category_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_mother_tongue_id_tenant_id_fkey" FOREIGN KEY ("mother_tongue_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_nationality_id_tenant_id_fkey" FOREIGN KEY ("nationality_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_disability_id_tenant_id_fkey" FOREIGN KEY ("disability_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_category_id_tenant_id_fkey" FOREIGN KEY ("category_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_state_id_tenant_id_fkey" FOREIGN KEY ("state_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_district_id_tenant_id_fkey" FOREIGN KEY ("district_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_city_id_tenant_id_fkey" FOREIGN KEY ("city_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_previous_board_id_tenant_id_fkey" FOREIGN KEY ("previous_board_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_leaving_reason_id_tenant_id_fkey" FOREIGN KEY ("leaving_reason_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_academic_year_id_tenant_id_fkey" FOREIGN KEY ("academic_year_id", "tenant_id") REFERENCES "academic_years"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_section_id_tenant_id_fkey" FOREIGN KEY ("section_id", "tenant_id") REFERENCES "sections"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_house_id_tenant_id_fkey" FOREIGN KEY ("house_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_student_id_tenant_id_fkey" FOREIGN KEY ("student_id", "tenant_id") REFERENCES "students"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_type_id_tenant_id_fkey" FOREIGN KEY ("type_id", "tenant_id") REFERENCES "master_values"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma can't express ------------------------------------------------

CREATE UNIQUE INDEX "students_admission_no_key" ON "students"("tenant_id", lower("admission_no"));
CREATE UNIQUE INDEX "students_aadhaar_key" ON "students"("tenant_id", "aadhaar") WHERE "aadhaar" IS NOT NULL;
CREATE UNIQUE INDEX "students_apaar_key" ON "students"("tenant_id", "apaar_id") WHERE "apaar_id" IS NOT NULL;
CREATE UNIQUE INDEX "students_pen_key" ON "students"("tenant_id", "pen") WHERE "pen" IS NOT NULL;
ALTER TABLE "students" ADD CONSTRAINT "students_names_check" CHECK ("first_name" = btrim("first_name") AND length("first_name") BETWEEN 1 AND 80 AND "admission_no" = btrim("admission_no") AND length("admission_no") BETWEEN 1 AND 40);

-- One roll number per section.
CREATE UNIQUE INDEX "enrolments_roll_key" ON "enrolments"("section_id", "roll_number") WHERE "roll_number" IS NOT NULL;
ALTER TABLE "enrolments" ADD CONSTRAINT "enrolments_roll_check" CHECK ("roll_number" IS NULL OR "roll_number" BETWEEN 1 AND 9999);

ALTER TABLE "guardians" ADD CONSTRAINT "guardians_name_check" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 120);
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_value_check" CHECK ("last_value" >= 0);
