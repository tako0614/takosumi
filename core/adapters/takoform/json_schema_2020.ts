import {
  validateFormDefinition,
  validateFormRef,
  validatePackageIndex,
  validatePackageIndexV1Alpha2,
} from "./schema_validators.generated.ts";

export interface StaticSchemaValidationError {
  readonly instancePath?: string;
  readonly schemaPath?: string;
  readonly keyword?: string;
  readonly message?: string;
}

export interface StaticSchemaValidator {
  (value: unknown): boolean;
  readonly errors?: readonly StaticSchemaValidationError[] | null;
}

export const validateTakoformFormRef = validateFormRef as StaticSchemaValidator;
export const validateTakoformPackageIndex =
  validatePackageIndex as StaticSchemaValidator;
export const validateTakoformPackageIndexV1Alpha2 =
  validatePackageIndexV1Alpha2 as StaticSchemaValidator;
export const validateTakoformFormDefinition =
  validateFormDefinition as StaticSchemaValidator;
