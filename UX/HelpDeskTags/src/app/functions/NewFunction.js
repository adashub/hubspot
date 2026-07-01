const https = require('https');

const API_HOSTNAME = 'api.hubapi.com';
const API_VERSION = '2026-03';
const DEMO_OBJECT_LABEL = 'demo';
const TICKET_OBJECT_TYPE_ID = '0-5';
const MIN_SEARCH_CHARACTERS = 3;
const MAX_SEARCH_RESULTS = 200;

class HubSpotApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'HubSpotApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

const normalize = value =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const buildContainsTokenValue = value =>
  `*${String(value || '')
    .replace(/\*/g, '')
    .trim()}*`;

const getSearchTokens = value =>
  String(value || '')
    .replace(/\*/g, ' ')
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter(token => token.length >= MIN_SEARCH_CHARACTERS)
    .slice(0, 6);

const getSearchRank = (record, requestedNameNormalized) => {
  const recordNameNormalized = normalize(record.name);

  if (recordNameNormalized === requestedNameNormalized) {
    return 0;
  }

  if (recordNameNormalized.startsWith(requestedNameNormalized)) {
    return 1;
  }

  if (recordNameNormalized.includes(requestedNameNormalized)) {
    return 2;
  }

  return 3;
};

const formatApiErrorMessage = (statusCode, parsedBody, responseBody) => {
  if (parsedBody && parsedBody.message) {
    return parsedBody.message;
  }

  if (parsedBody && parsedBody.category) {
    return `${parsedBody.category}: HubSpot API request failed.`;
  }

  if (parsedBody && Array.isArray(parsedBody.errors)) {
    const messages = parsedBody.errors
      .map(error => error && error.message)
      .filter(Boolean);

    if (messages.length) {
      return messages.join(' ');
    }
  }

  if (responseBody) {
    return `HubSpot API request failed (${statusCode}): ${responseBody.slice(
      0,
      500,
    )}`;
  }

  return `HubSpot API request failed (${statusCode}).`;
};

const apiRequest = (method, path, body) => {
  const token = process.env.PRIVATE_APP_ACCESS_TOKEN;

  if (!token) {
    throw new HubSpotApiError(
      500,
      'PRIVATE_APP_ACCESS_TOKEN is not available to the app function.',
    );
  }

  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: API_HOSTNAME,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      response => {
        let responseBody = '';

        response.on('data', chunk => {
          responseBody += chunk;
        });

        response.on('end', () => {
          let parsedBody = {};

          if (responseBody) {
            try {
              parsedBody = JSON.parse(responseBody);
            } catch {
              parsedBody = { raw: responseBody };
            }
          }

          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(parsedBody);
            return;
          }

          reject(
            new HubSpotApiError(
              response.statusCode,
              formatApiErrorMessage(
                response.statusCode,
                parsedBody,
                responseBody,
              ),
              parsedBody,
            ),
          );
        });
      },
    );

    request.on('error', reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
};

const ok = body => ({
  statusCode: 200,
  body: {
    success: true,
    ...body,
  },
});

const fail = (statusCode, error, extra = {}) => ({
  statusCode,
  body: {
    success: false,
    error,
    ...extra,
  },
});

const findDemoSchema = async () => {
  const schemas = await apiRequest(
    'GET',
    `/crm-object-schemas/${API_VERSION}/schemas?includePropertyDefinitions=true&includeAssociationDefinitions=true&archived=false`,
  );
  const results = Array.isArray(schemas.results) ? schemas.results : [];

  const match = results.find(schema => {
    const names = [
      schema.name,
      schema.fullyQualifiedName,
      schema.labels && schema.labels.singular,
      schema.labels && schema.labels.plural,
    ];

    return names.some(name => {
      const normalized = normalize(name);

      return (
        normalized === DEMO_OBJECT_LABEL ||
        normalized === `${DEMO_OBJECT_LABEL}s` ||
        normalized.endsWith(DEMO_OBJECT_LABEL)
      );
    });
  });

  if (!match) {
    throw new HubSpotApiError(
      404,
      'Could not find a custom object schema named Demo.',
    );
  }

  const primaryDisplayProperty =
    match.primaryDisplayProperty ||
    (Array.isArray(match.properties)
      ? match.properties.find(property => normalize(property.label) === 'name')
          ?.name
      : undefined) ||
    'name';

  return {
    ...match,
    primaryDisplayProperty,
  };
};

let demoSchemaPromise;

const getDemoSchema = () => {
  if (!demoSchemaPromise) {
    demoSchemaPromise = findDemoSchema().catch(error => {
      demoSchemaPromise = undefined;
      throw error;
    });
  }

  return demoSchemaPromise;
};

const toRecord = (record, primaryDisplayProperty) => ({
  id: String(record.id),
  name:
    (record.properties && record.properties[primaryDisplayProperty]) ||
    (record.properties && record.properties.name) ||
    `Demo ${record.id}`,
});

const readDemoRecords = async (schema, ids) => {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];

  if (!uniqueIds.length) {
    return [];
  }

  const response = await apiRequest(
    'POST',
    `/crm/objects/${API_VERSION}/${encodeURIComponent(
      schema.objectTypeId,
    )}/batch/read`,
    {
      properties: [schema.primaryDisplayProperty],
      inputs: uniqueIds.map(id => ({ id })),
    },
  );

  return (response.results || [])
    .map(record => toRecord(record, schema.primaryDisplayProperty))
    .sort((left, right) => left.name.localeCompare(right.name));
};

const getAssociatedDemoIds = async (ticketId, schema) => {
  try {
    const response = await apiRequest(
      'POST',
      `/crm/associations/${API_VERSION}/${TICKET_OBJECT_TYPE_ID}/${encodeURIComponent(
        schema.objectTypeId,
      )}/batch/read`,
      {
        inputs: [{ id: String(ticketId) }],
      },
    );
    const associations = response.results && response.results[0];

    if (associations && Array.isArray(associations.to)) {
      return associations.to
        .map(record => record.id || record.toObjectId || record.to?.id)
        .filter(Boolean);
    }
  } catch (error) {
    if (error.statusCode !== 404) {
      throw error;
    }
  }

  const ticket = await apiRequest(
    'GET',
    `/crm/objects/${API_VERSION}/${TICKET_OBJECT_TYPE_ID}/${encodeURIComponent(
      ticketId,
    )}?associations=${encodeURIComponent(schema.objectTypeId)}`,
  );
  const associations =
    ticket.associations &&
    (ticket.associations[schema.objectTypeId] ||
      ticket.associations[schema.fullyQualifiedName]);

  return associations && Array.isArray(associations.results)
    ? associations.results.map(record => record.id)
    : [];
};

const loadTags = async (ticketId, schema) => {
  const associatedIds = await getAssociatedDemoIds(ticketId, schema);

  return readDemoRecords(schema, associatedIds);
};

const searchDemoRecords = async (schema, name) => {
  const requestedName = String(name || '').trim();

  if (requestedName.length < MIN_SEARCH_CHARACTERS) {
    return { records: [], total: 0 };
  }

  const filters = getSearchTokens(requestedName).map(token => ({
    propertyName: schema.primaryDisplayProperty,
    operator: 'CONTAINS_TOKEN',
    value: buildContainsTokenValue(token),
  }));

  if (!filters.length) {
    return { records: [], total: 0 };
  }

  const response = await apiRequest(
    'POST',
    `/crm/objects/${API_VERSION}/${encodeURIComponent(
      schema.objectTypeId,
    )}/search`,
    {
      filterGroups: [
        {
          filters,
        },
      ],
      properties: [schema.primaryDisplayProperty],
      limit: MAX_SEARCH_RESULTS,
    },
  );
  const records = (response.results || []).map(record =>
    toRecord(record, schema.primaryDisplayProperty),
  );
  const requestedNameNormalized = normalize(requestedName);
  const total = Number(response.total);

  const sortedRecords = records
    .map(record => ({
      ...record,
      exact: normalize(record.name) === requestedNameNormalized,
    }))
    .sort((left, right) => {
      if (left.exact && !right.exact) {
        return -1;
      }

      if (!left.exact && right.exact) {
        return 1;
      }

      const leftRank = getSearchRank(left, requestedNameNormalized);
      const rightRank = getSearchRank(right, requestedNameNormalized);

      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }

      return left.name.localeCompare(right.name);
    });

  return {
    records: sortedRecords,
    total: Number.isFinite(total) ? total : sortedRecords.length,
  };
};

const findExactDemoRecord = async (schema, name) => {
  const requestedName = String(name || '').trim();

  if (!requestedName) {
    return undefined;
  }

  const response = await apiRequest(
    'POST',
    `/crm/objects/${API_VERSION}/${encodeURIComponent(
      schema.objectTypeId,
    )}/search`,
    {
      filterGroups: [
        {
          filters: [
            {
              propertyName: schema.primaryDisplayProperty,
              operator: 'EQ',
              value: requestedName,
            },
          ],
        },
      ],
      properties: [schema.primaryDisplayProperty],
      limit: 1,
    },
  );
  const requestedNameNormalized = normalize(requestedName);
  const exactRecord = (response.results || [])
    .map(record => toRecord(record, schema.primaryDisplayProperty))
    .find(record => normalize(record.name) === requestedNameNormalized);

  return exactRecord
    ? {
        ...exactRecord,
        exact: true,
      }
    : undefined;
};

const associateDemoToTicket = async (schema, demoRecordId, ticketId) => {
  verifyDemoTicketAssociation(schema);

  const attempts = [
    {
      fromType: TICKET_OBJECT_TYPE_ID,
      fromRecordId: ticketId,
      toType: schema.objectTypeId,
      toRecordId: demoRecordId,
    },
    {
      fromType: schema.objectTypeId,
      fromRecordId: demoRecordId,
      toType: TICKET_OBJECT_TYPE_ID,
      toRecordId: ticketId,
    },
  ];
  const failures = [];

  for (const attempt of attempts) {
    try {
      await apiRequest(
        'PUT',
        `/crm/objects/${API_VERSION}/${encodeURIComponent(
          attempt.fromType,
        )}/${encodeURIComponent(
          attempt.fromRecordId,
        )}/associations/default/${encodeURIComponent(
          attempt.toType,
        )}/${encodeURIComponent(attempt.toRecordId)}`,
      );

      return;
    } catch (error) {
      const message = String(error.message || '').toLowerCase();

      if (message.includes('already') || error.statusCode === 409) {
        return;
      }

      failures.push(error);
    }
  }

  const firstFailure = failures[0];
  const failureMessage = firstFailure && firstFailure.message;

  throw new HubSpotApiError(
    (firstFailure && firstFailure.statusCode) || 400,
    failureMessage ||
      'Unable to associate Demo to this ticket. Confirm the Demo custom object schema allows associations with tickets.',
    firstFailure && firstFailure.details,
  );
};

const verifyDemoTicketAssociation = schema => {
  const hasTicketAssociation = (schema.associations || []).some(
    association =>
      (association.fromObjectTypeId === schema.objectTypeId &&
        association.toObjectTypeId === TICKET_OBJECT_TYPE_ID) ||
      (association.fromObjectTypeId === TICKET_OBJECT_TYPE_ID &&
        association.toObjectTypeId === schema.objectTypeId),
  );

  if (!hasTicketAssociation) {
    throw new HubSpotApiError(
      400,
      'The Demo custom object schema does not define an association with tickets.',
    );
  }
};

const createDemoRecord = async (schema, name) => {
  const response = await apiRequest(
    'POST',
    `/crm/objects/${API_VERSION}/${encodeURIComponent(schema.objectTypeId)}`,
    {
      properties: {
        [schema.primaryDisplayProperty]: name,
      },
    },
  );

  return toRecord(response, schema.primaryDisplayProperty);
};

exports.main = async (context = {}) => {
  const parameters = context.parameters || {};
  const { action, ticketId, name, demoRecordId, allowDuplicate } = parameters;

  if (!ticketId) {
    return fail(400, 'The current ticket ID was not provided to the card.');
  }

  try {
    const schema = await getDemoSchema();

    if (action === 'load') {
      return ok({
        tags: await loadTags(ticketId, schema),
        suggestions: [],
      });
    }

    if (action === 'search') {
      const searchResult = await searchDemoRecords(schema, String(name || ''));

      return ok({
        suggestions: searchResult.records,
        suggestionTotal: searchResult.total,
      });
    }

    if (action === 'associate') {
      if (!demoRecordId) {
        return fail(400, 'A Demo record ID is required.');
      }

      await associateDemoToTicket(schema, String(demoRecordId), String(ticketId));

      return ok({
        tags: await loadTags(ticketId, schema),
        suggestions: [],
      });
    }

    if (action === 'createAndAssociate') {
      const demoName = String(name || '').trim();

      if (!demoName) {
        return fail(400, 'A Demo name is required.');
      }

      const exactMatch = allowDuplicate
        ? undefined
        : await findExactDemoRecord(schema, demoName);

      if (exactMatch && !allowDuplicate) {
        const searchResult =
          demoName.length >= MIN_SEARCH_CHARACTERS
            ? await searchDemoRecords(schema, demoName)
            : { records: [exactMatch], total: 1 };

        return fail(409, 'A Demo record with this name already exists.', {
          duplicateFound: true,
          suggestions: searchResult.records.length
            ? searchResult.records
            : [exactMatch],
          suggestionTotal: searchResult.total || 1,
        });
      }

      const createdRecord = await createDemoRecord(schema, demoName);
      await associateDemoToTicket(schema, createdRecord.id, String(ticketId));

      return ok({
        createdRecord,
        tags: await loadTags(ticketId, schema),
        suggestions: [],
      });
    }

    return fail(400, `Unsupported action: ${action}`);
  } catch (error) {
    console.error('HelpDeskTags app function failed', {
      message: error.message,
      details: error.details,
    });

    return fail(
      error.statusCode || 500,
      error.message || 'Unexpected app function error.',
    );
  }
};
