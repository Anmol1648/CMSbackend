-- CreateTable
CREATE TABLE "id_card_designs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "orientation" TEXT NOT NULL DEFAULT 'portrait',
    "color" TEXT NOT NULL DEFAULT '#1A365D',
    "text_color" TEXT NOT NULL DEFAULT '#FFFFFF',
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "code" TEXT NOT NULL DEFAULT 'qr',
    "back" BOOLEAN NOT NULL DEFAULT true,
    "back_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "back_text" TEXT,
    "signature_file_id" UUID,
    "signature_label" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "id_card_designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "card_no" TEXT NOT NULL,
    "design_id" UUID,
    "holder_type" TEXT NOT NULL,
    "student_id" UUID,
    "staff_id" UUID,
    "academic_year_id" UUID,
    "valid_until" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reason" TEXT NOT NULL DEFAULT 'new',
    "fee" INTEGER,
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "last_printed_at" TIMESTAMPTZ(6),
    "issued_by" UUID,
    "replaced_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_photo_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "answered_by" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_photo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "id_card_designs_id_tenant_id_key" ON "id_card_designs"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "id_cards_tenant_id_student_id_idx" ON "id_cards"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "id_cards_tenant_id_staff_id_idx" ON "id_cards"("tenant_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_cards_tenant_id_card_no_key" ON "id_cards"("tenant_id", "card_no");

-- CreateIndex
CREATE INDEX "id_photo_requests_tenant_id_status_idx" ON "id_photo_requests"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "id_card_designs" ADD CONSTRAINT "id_card_designs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_cards" ADD CONSTRAINT "id_cards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_cards" ADD CONSTRAINT "id_cards_design_id_tenant_id_fkey" FOREIGN KEY ("design_id", "tenant_id") REFERENCES "id_card_designs"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_photo_requests" ADD CONSTRAINT "id_photo_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
