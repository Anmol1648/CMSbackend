-- AlterTable
ALTER TABLE "exams" ADD COLUMN     "admit_released" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "candidates" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'regular';

-- AlterTable
ALTER TABLE "result_rules" ADD COLUMN     "card_format" TEXT NOT NULL DEFAULT 'standard';

-- AlterTable
ALTER TABLE "school_profiles" ADD COLUMN     "signature_file_id" UUID;

-- CreateTable
CREATE TABLE "exam_sheet_locks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "exam_subject_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_sheet_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_seats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "start_time" TEXT NOT NULL DEFAULT '',
    "room_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "seat_no" INTEGER NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "exam_seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_duties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "start_time" TEXT NOT NULL DEFAULT '',
    "end_time" TEXT,
    "room_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "exam_duties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_papers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "duration_mins" INTEGER NOT NULL DEFAULT 180,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "file_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_health" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "term_key" TEXT NOT NULL DEFAULT 'year',
    "student_id" UUID NOT NULL,
    "height_cm" DOUBLE PRECISION,
    "weight_kg" DOUBLE PRECISION,
    "vision" TEXT,
    "activities" TEXT,
    "entered_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "student_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_rechecks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "exam_subject_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "requested_by" UUID,
    "reason" TEXT,
    "fee" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "old_marks" JSONB NOT NULL DEFAULT '{}',
    "old_total" DOUBLE PRECISION,
    "new_marks" JSONB,
    "new_total" DOUBLE PRECISION,
    "review_note" TEXT,
    "reviewed_by" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_rechecks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exam_sheet_locks_exam_subject_id_section_id_key" ON "exam_sheet_locks"("exam_subject_id", "section_id");

-- CreateIndex
CREATE INDEX "exam_seats_tenant_id_exam_id_date_idx" ON "exam_seats"("tenant_id", "exam_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "exam_seats_exam_id_date_start_time_student_id_key" ON "exam_seats"("exam_id", "date", "start_time", "student_id");

-- CreateIndex
CREATE INDEX "exam_duties_tenant_id_exam_id_date_idx" ON "exam_duties"("tenant_id", "exam_id", "date");

-- CreateIndex
CREATE INDEX "exam_duties_tenant_id_staff_id_date_idx" ON "exam_duties"("tenant_id", "staff_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "exam_papers_exam_id_class_id_subject_id_key" ON "exam_papers"("exam_id", "class_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_health_academic_year_id_term_key_student_id_key" ON "student_health"("academic_year_id", "term_key", "student_id");

-- CreateIndex
CREATE INDEX "exam_rechecks_tenant_id_status_idx" ON "exam_rechecks"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "exam_sheet_locks" ADD CONSTRAINT "exam_sheet_locks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_seats" ADD CONSTRAINT "exam_seats_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_duties" ADD CONSTRAINT "exam_duties_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_health" ADD CONSTRAINT "student_health_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_rechecks" ADD CONSTRAINT "exam_rechecks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
