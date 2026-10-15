import { v2 as cloudinary } from 'cloudinary';

export interface StorageOptions {
    folder?: string;
    publicId?: string;
    resourceType?: 'image' | 'video' | 'raw' | 'auto';
}

export interface UploadResult {
    url: string;
    publicId: string;
    format: string;
    bytes: number;
    resourceType: string;
}

export interface IStorageProvider {
    upload(file: Buffer | string, options?: StorageOptions): Promise<UploadResult>;
    delete(publicId: string): Promise<void>;
}

export class CloudinaryStorageProvider implements IStorageProvider {
    constructor() {
        cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET,
            secure: true
        });
    }

    async upload(file: Buffer | string, options?: StorageOptions): Promise<UploadResult> {
        return new Promise((resolve, reject) => {
            const uploadOptions = {
                folder: options?.folder || 'cms',
                public_id: options?.publicId,
                resource_type: options?.resourceType || 'auto',
            };

            const uploadStream = cloudinary.uploader.upload_stream(
                uploadOptions,
                (error, result) => {
                    if (error) return reject(error);
                    if (!result) return reject(new Error('Cloudinary upload returned no result'));
                    
                    resolve({
                        url: result.secure_url,
                        publicId: result.public_id,
                        format: result.format,
                        bytes: result.bytes,
                        resourceType: result.resource_type,
                    });
                }
            );

            if (Buffer.isBuffer(file)) {
                uploadStream.end(file);
            } else {
                // If it's a string (e.g. file path or base64), we use the regular upload
                cloudinary.uploader.upload(file, uploadOptions)
                    .then((result) => resolve({
                        url: result.secure_url,
                        publicId: result.public_id,
                        format: result.format,
                        bytes: result.bytes,
                        resourceType: result.resource_type,
                    }))
                    .catch(reject);
            }
        });
    }

    async delete(publicId: string): Promise<void> {
        await cloudinary.uploader.destroy(publicId);
    }
}

// Factory for future swappability
export type StorageType = 'cloudinary' | 's3' | 'local';

export class StorageFactory {
    static getProvider(type: StorageType = 'cloudinary'): IStorageProvider {
        switch (type) {
            case 'cloudinary':
                return new CloudinaryStorageProvider();
            // case 's3': return new S3StorageProvider();
            default:
                throw new Error(`Storage provider [${type}] not implemented`);
        }
    }
}
