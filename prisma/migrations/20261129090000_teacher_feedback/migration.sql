-- CreateTable
CREATE TABLE "feedback_forms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'student',
    "questions" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedback_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_rounds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'student',
    "section_ids" UUID[],
    "anonymous" BOOLEAN NOT NULL DEFAULT true,
    "opens_on" DATE NOT NULL,
    "closes_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "released_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feedback_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_responses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "respondent_kind" TEXT NOT NULL,
    "user_id" UUID,
    "student_id" UUID,
    "answers" JSONB NOT NULL,
    "comment" TEXT,
    "comment_status" TEXT NOT NULL DEFAULT 'shown',
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback_completions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "feedback_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feedback_forms_id_tenant_id_key" ON "feedback_forms"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_rounds_id_tenant_id_key" ON "feedback_rounds"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "feedback_responses_tenant_id_round_id_staff_id_idx" ON "feedback_responses"("tenant_id", "round_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_completions_round_id_user_id_student_id_staff_id_key" ON "feedback_completions"("round_id", "user_id", "student_id", "staff_id");

-- AddForeignKey
ALTER TABLE "feedback_forms" ADD CONSTRAINT "feedback_forms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_rounds" ADD CONSTRAINT "feedback_rounds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_rounds" ADD CONSTRAINT "feedback_rounds_form_id_tenant_id_fkey" FOREIGN KEY ("form_id", "tenant_id") REFERENCES "feedback_forms"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "feedback_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_completions" ADD CONSTRAINT "feedback_completions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback_completions" ADD CONSTRAINT "feedback_completions_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "feedback_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
