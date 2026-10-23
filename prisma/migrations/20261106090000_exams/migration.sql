-- CreateTable
CREATE TABLE "grade_scales" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'marks',
    "bands" JSONB NOT NULL DEFAULT '[]',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "grade_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "class_group_id" UUID,
    "descriptive" BOOLEAN NOT NULL DEFAULT false,
    "grade_scale_id" UUID,
    "co_scale_id" UUID,
    "pass_percent" DOUBLE PRECISION NOT NULL DEFAULT 33,
    "pass_each_part" BOOLEAN NOT NULL DEFAULT false,
    "grace_marks" INTEGER NOT NULL DEFAULT 0,
    "grace_subjects" INTEGER NOT NULL DEFAULT 0,
    "show_rank" BOOLEAN NOT NULL DEFAULT false,
    "show_attendance" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "result_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_terms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "exam_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "term_id" UUID,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "class_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "components" JSONB NOT NULL DEFAULT '[]',
    "weightage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "counts_in_result" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "entry_deadline" DATE,
    "datesheet_notice_id" UUID,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_subjects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "components" JSONB NOT NULL DEFAULT '[]',
    "date" DATE,
    "start_time" TEXT,
    "end_time" TEXT,
    "room" TEXT,
    "invigilator_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_marks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "exam_subject_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "marks" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'P',
    "total" DOUBLE PRECISION,
    "entered_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_student_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "co_grades" JSONB NOT NULL DEFAULT '{}',
    "discipline" TEXT,
    "remark" TEXT,
    "entered_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exam_student_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_publications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "term_id" UUID,
    "published_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_terms_tenant_id_academic_year_id_idx" ON "exam_terms"("tenant_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_terms_id_tenant_id_key" ON "exam_terms"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "exams_tenant_id_academic_year_id_idx" ON "exams"("tenant_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "exams_id_tenant_id_key" ON "exams"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subjects_id_tenant_id_key" ON "exam_subjects"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subjects_exam_id_class_id_subject_id_key" ON "exam_subjects"("exam_id", "class_id", "subject_id");

-- CreateIndex
CREATE INDEX "exam_marks_tenant_id_student_id_idx" ON "exam_marks"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_marks_exam_subject_id_student_id_key" ON "exam_marks"("exam_subject_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_student_notes_exam_id_student_id_key" ON "exam_student_notes"("exam_id", "student_id");

-- CreateIndex
CREATE INDEX "result_publications_tenant_id_academic_year_id_idx" ON "result_publications"("tenant_id", "academic_year_id");

-- AddForeignKey
ALTER TABLE "grade_scales" ADD CONSTRAINT "grade_scales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_rules" ADD CONSTRAINT "result_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_terms" ADD CONSTRAINT "exam_terms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_term_id_tenant_id_fkey" FOREIGN KEY ("term_id", "tenant_id") REFERENCES "exam_terms"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_exam_id_tenant_id_fkey" FOREIGN KEY ("exam_id", "tenant_id") REFERENCES "exams"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_marks" ADD CONSTRAINT "exam_marks_exam_subject_id_tenant_id_fkey" FOREIGN KEY ("exam_subject_id", "tenant_id") REFERENCES "exam_subjects"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_student_notes" ADD CONSTRAINT "exam_student_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_student_notes" ADD CONSTRAINT "exam_student_notes_exam_id_tenant_id_fkey" FOREIGN KEY ("exam_id", "tenant_id") REFERENCES "exams"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_publications" ADD CONSTRAINT "result_publications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
