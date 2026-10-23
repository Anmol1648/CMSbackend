-- CreateTable
CREATE TABLE "online_tests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "section_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "chapter_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "duration_min" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "shuffle_questions" BOOLEAN NOT NULL DEFAULT true,
    "shuffle_options" BOOLEAN NOT NULL DEFAULT true,
    "show_result" TEXT NOT NULL DEFAULT 'after_review',
    "negative_marks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_marks" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "results_at" TIMESTAMPTZ(6),
    "alerted_at" TIMESTAMPTZ(6),
    "staff_id" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "online_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_test_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "test_id" UUID NOT NULL,
    "question_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "marks" DOUBLE PRECISION NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "online_test_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "test_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "layout" JSONB NOT NULL DEFAULT '{}',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "marks" JSONB NOT NULL DEFAULT '{}',
    "score" DOUBLE PRECISION,
    "marked_by" UUID,
    "marked_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "test_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "online_tests_tenant_id_class_id_subject_id_idx" ON "online_tests"("tenant_id", "class_id", "subject_id");

-- CreateIndex
CREATE INDEX "online_tests_tenant_id_starts_at_idx" ON "online_tests"("tenant_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "online_tests_id_tenant_id_key" ON "online_tests"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "online_test_questions_tenant_id_test_id_idx" ON "online_test_questions"("tenant_id", "test_id");

-- CreateIndex
CREATE INDEX "test_attempts_tenant_id_student_id_idx" ON "test_attempts"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_attempts_test_id_student_id_key" ON "test_attempts"("test_id", "student_id");

-- AddForeignKey
ALTER TABLE "online_tests" ADD CONSTRAINT "online_tests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_test_questions" ADD CONSTRAINT "online_test_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_test_questions" ADD CONSTRAINT "online_test_questions_test_id_tenant_id_fkey" FOREIGN KEY ("test_id", "tenant_id") REFERENCES "online_tests"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_attempts" ADD CONSTRAINT "test_attempts_test_id_tenant_id_fkey" FOREIGN KEY ("test_id", "tenant_id") REFERENCES "online_tests"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
