import { DataTypes, Model, Sequelize } from 'sequelize';

export class Tenant extends Model {
  public id!: string;
  public name!: string;
  public slug!: string;
  public db_host!: string;
  public db_name!: string;
  public db_credentials_encrypted!: string;
  public status!: 'active' | 'suspended' | 'provisioning';
  public domain!: string;
}

export function initTenantModel(sequelize: Sequelize): typeof Tenant {
  Tenant.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      db_host: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      db_name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      db_credentials_encrypted: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('active', 'suspended', 'provisioning'),
        defaultValue: 'provisioning',
        allowNull: false,
      },
      domain: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
    },
    {
      sequelize,
      tableName: 'tenants',
      timestamps: true,
    }
  );
  return Tenant;
}
