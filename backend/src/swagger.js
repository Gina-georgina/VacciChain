const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'VacciChain Backend API',
      version: '1.0.0',
      description: 'Blockchain-based vaccination records on Stellar — soulbound, verifiable, tamper-proof.',
    },
    servers: [
      {
        url: 'http://localhost:4000',
        description: 'Development server',
      },
      {
        url: 'http://backend:4000',
        description: 'Docker server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
            },
          },
        },
        VaccinationRecord: {
          type: 'object',
          properties: {
            vaccine_name: {
              type: 'string',
            },
            date_administered: {
              type: 'string',
              format: 'date',
              description:
                'Date-only field in ISO 8601 calendar format (YYYY-MM-DD), e.g. "2023-02-28". ' +
                'Represents the local calendar date of administration and is never shifted by time zone. ' +
                'Ambiguous values (timestamps, partial dates, non-ISO formats, or invalid calendar dates such as "2023-02-30") are rejected.',
              example: '2023-02-28',
            },
            issuer: {
              type: 'string',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
              description:
                'Timestamp field in ISO 8601 format (YYYY-MM-DDTHH:mm:ss[.sss]Z or with an explicit numeric offset). ' +
                'Values are normalized to UTC for storage and indexing; offsets are converted, not truncated. ' +
                'Ambiguous values (date-only strings, missing time zone designators, or non-ISO formats) are rejected.',
              example: '2023-02-28T23:30:00.000Z',
            },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
