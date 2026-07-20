import {
  validateFormDefinition,
  validateFormRef,
  validatePackageIndex,
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
export const validateTakoformFormDefinition =
  validateFormDefinition as StaticSchemaValidator;
