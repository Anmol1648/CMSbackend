-- Menu Setup: a school can show or hide each page in the mobile app (null = the page's default).
ALTER TABLE "menu_customizations" ADD COLUMN "in_app" BOOLEAN;
