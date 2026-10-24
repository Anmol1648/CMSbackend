-- CreateTable
CREATE TABLE "custom_widgets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "definition" JSONB NOT NULL,
    "size" TEXT NOT NULL DEFAULT 'sm',
    "role_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "href" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "custom_widgets_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "custom_widgets" ADD CONSTRAINT "custom_widgets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
