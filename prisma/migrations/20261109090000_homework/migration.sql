-- CreateTable
CREATE TABLE "homework" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "type_id" UUID,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "attachment_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "given_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'online',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publish_at" TIMESTAMPTZ(6),
    "alerted_at" TIMESTAMPTZ(6),
    "staff_id" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "homework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "homework_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "homework_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "answer" TEXT,
    "file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by" UUID,
    "checked_at" TIMESTAMPTZ(6),
    "checked_by" UUID,
    "grade_id" UUID,
    "remark" TEXT,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "homework_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "homework_tenant_id_section_id_due_on_idx" ON "homework"("tenant_id", "section_id", "due_on");

-- CreateIndex
CREATE INDEX "homework_tenant_id_staff_id_given_on_idx" ON "homework"("tenant_id", "staff_id", "given_on");

-- CreateIndex
CREATE UNIQUE INDEX "homework_id_tenant_id_key" ON "homework"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "homework_submissions_tenant_id_student_id_idx" ON "homework_submissions"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "homework_submissions_homework_id_student_id_key" ON "homework_submissions"("homework_id", "student_id");

-- AddForeignKey
ALTER TABLE "homework" ADD CONSTRAINT "homework_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homework_submissions" ADD CONSTRAINT "homework_submissions_homework_id_tenant_id_fkey" FOREIGN KEY ("homework_id", "tenant_id") REFERENCES "homework"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
