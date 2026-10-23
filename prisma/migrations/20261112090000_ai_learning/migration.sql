-- CreateTable
CREATE TABLE "learn_chats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "chapter_id" UUID,
    "mode" TEXT NOT NULL DEFAULT 'ask',
    "title" TEXT NOT NULL,
    "messages" INTEGER NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "learn_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learn_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "flag" TEXT NOT NULL DEFAULT 'ok',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "learn_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_quizzes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "chapter_id" UUID,
    "source" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "score" INTEGER,
    "total" INTEGER NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "practice_quizzes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learn_chats_tenant_id_student_id_updated_at_idx" ON "learn_chats"("tenant_id", "student_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "learn_chats_id_tenant_id_key" ON "learn_chats"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "learn_messages_tenant_id_chat_id_created_at_idx" ON "learn_messages"("tenant_id", "chat_id", "created_at");

-- CreateIndex
CREATE INDEX "practice_quizzes_tenant_id_student_id_created_at_idx" ON "practice_quizzes"("tenant_id", "student_id", "created_at");

-- AddForeignKey
ALTER TABLE "learn_chats" ADD CONSTRAINT "learn_chats_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learn_messages" ADD CONSTRAINT "learn_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learn_messages" ADD CONSTRAINT "learn_messages_chat_id_tenant_id_fkey" FOREIGN KEY ("chat_id", "tenant_id") REFERENCES "learn_chats"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_quizzes" ADD CONSTRAINT "practice_quizzes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
