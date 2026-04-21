import { Sequelize } from 'sequelize';
import { initTenantModel } from './models/Tenant';
import dotenv from 'dotenv';
dotenv.config();

export const centralDb = process.env.DATABASE_URL 
  ? new Sequelize(process.env.DATABASE_URL, { dialect: 'postgres', logging: false, dialectOptions: { ssl: { require: true, rejectUnauthorized: false } } })
  : new Sequelize(
      process.env.CENTRAL_DB_NAME || 'cms_central',
      process.env.CENTRAL_DB_USER || 'postgres',
      process.env.CENTRAL_DB_PASSWORD || 'password',
      {
        host: process.env.CENTRAL_DB_HOST || 'localhost',
        dialect: 'postgres',
        logging: false,
      }
    );

export const TenantModel = initTenantModel(centralDb);

export async function connectCentralDb() {
  try {
    await centralDb.authenticate();
    await centralDb.sync(); // Sync centrally for now; in prod use migrations
    console.log('Connected to Central DB successfully.');
  } catch (error) {
    console.error('Failed to connect to Central DB:', error);
  }
}
