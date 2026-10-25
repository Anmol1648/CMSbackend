-- CreateTable
CREATE TABLE "platform_leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "school" TEXT NOT NULL,
    "city" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "students" INTEGER,
    "board" TEXT,
    "preferred_time" TEXT,
    "message" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "platform_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_leads_status_created_at_idx" ON "platform_leads"("status", "created_at");
