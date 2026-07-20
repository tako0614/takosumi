import { validateTakoformFormDefinition } from "../../../core/adapters/takoform/json_schema_2020.ts";
import { InterpretedDraft202012Validator } from "../../../core/shared/json-schema/draft_2020.ts";

export default {
  fetch(): Response {
    const validator = new InterpretedDraft202012Validator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    return Response.json({
      fixedSchemaRejectedInvalidDefinition:
        !validateTakoformFormDefinition(null),
      interpretedSchemaAcceptedValidInstance: validator.validate({
        name: "store",
      }),
      interpretedSchemaRejectedInvalidInstance: !validator.validate({}),
    });
  },
};
