import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hubspot } from '@hubspot/ui-extensions';
import {
  Alert,
  Button,
  CrmContext,
  Divider,
  EmptyState,
  ExtensionPointApiActions,
  Flex,
  Heading,
  Input,
  LoadingSpinner,
  Tag,
  Text,
  Tile,
  useDebounce,
} from '@hubspot/ui-extensions';

const APP_FUNCTION_UID = 'HelpDeskTags_app_function';
const MIN_SEARCH_CHARACTERS = 3;
const SEARCH_DEBOUNCE_MS = 350;

interface CrmExtensionProps {
  context: CrmContext;
  actions: ExtensionPointApiActions<'helpdesk.sidebar'>;
}

interface DemoRecord {
  id: string;
  name: string;
  exact?: boolean;
}

interface DemoResponse {
  success: boolean;
  tags?: DemoRecord[];
  suggestions?: DemoRecord[];
  suggestionTotal?: number;
  duplicateFound?: boolean;
  associatedRecord?: DemoRecord;
  createdRecord?: DemoRecord;
  error?: string;
}

interface ServerlessResult {
  body?: unknown;
}

interface SearchCacheEntry {
  suggestions: DemoRecord[];
  total: number;
}

type DemoAction = 'load' | 'search' | 'associate' | 'createAndAssociate';

hubspot.extend<'helpdesk.sidebar'>(({ context, actions }: CrmExtensionProps) => (
  <CrmExtension context={context} actions={actions} />
));

const isDemoResponse = (value: unknown): value is DemoResponse => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as { success: unknown }).success === 'boolean'
  );
};

const toDemoResponse = (result: ServerlessResult): DemoResponse => {
  const rawBody = result.body ?? result;

  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody) as unknown;

      if (isDemoResponse(parsed)) {
        return parsed;
      }
    } catch {
      return { success: false, error: rawBody };
    }
  }

  if (isDemoResponse(rawBody)) {
    return rawBody;
  }

  return { success: false, error: 'Unexpected response from app function.' };
};

const normalizeName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const CrmExtension = ({ context, actions }: CrmExtensionProps) => {
  const ticketId = context.crm.objectId;
  const ticketObjectTypeId = context.crm.objectTypeId;
  const [demoName, setDemoName] = useState('');
  const [tags, setTags] = useState<DemoRecord[]>([]);
  const [suggestions, setSuggestions] = useState<DemoRecord[]>([]);
  const [suggestionTotal, setSuggestionTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const searchCacheRef = useRef<Record<string, SearchCacheEntry>>({});
  const activeSearchRef = useRef(0);
  const latestSearchTermRef = useRef('');

  const trimmedDemoName = useMemo(() => demoName.trim(), [demoName]);
  const debouncedDemoName = useDebounce(trimmedDemoName, SEARCH_DEBOUNCE_MS);
  const searchPending =
    trimmedDemoName.length >= MIN_SEARCH_CHARACTERS &&
    debouncedDemoName !== trimmedDemoName;
  const searchInProgress = searching || searchPending;
  const searchReady =
    trimmedDemoName.length >= MIN_SEARCH_CHARACTERS &&
    debouncedDemoName === trimmedDemoName &&
    !searching;
  const suggestionsHeading =
    suggestionTotal > suggestions.length
      ? `Existing Demo records (${suggestions.length} of ${suggestionTotal})`
      : `Existing Demo records (${suggestionTotal || suggestions.length})`;
  const exactSuggestion = useMemo(
    () =>
      suggestions.find(
        suggestion =>
          normalizeName(suggestion.name) === normalizeName(trimmedDemoName),
      ),
    [suggestions, trimmedDemoName],
  );

  const callFunction = useCallback(
    async (action: DemoAction, parameters: Record<string, unknown> = {}) => {
      const result = (await hubspot.serverless(APP_FUNCTION_UID, {
        parameters: {
          action,
          ticketId,
          ticketObjectTypeId,
          ...parameters,
        },
      })) as ServerlessResult;

      return toDemoResponse(result);
    },
    [ticketId, ticketObjectTypeId],
  );

  const applyResponse = useCallback((response: DemoResponse) => {
    if (response.tags) {
      setTags(response.tags);
    }

    if (response.suggestions) {
      setSuggestions(response.suggestions);
      setSuggestionTotal(
        response.suggestionTotal ?? response.suggestions.length,
      );
    }

    setError(response.success ? '' : response.error || 'Request failed.');
  }, []);

  const loadTags = useCallback(async () => {
    setLoading(true);

    try {
      const response = await callFunction('load');
      applyResponse(response);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load Demo tags.',
      );
    } finally {
      setLoading(false);
    }
  }, [applyResponse, callFunction]);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  useEffect(() => {
    const searchTerm = debouncedDemoName.trim();
    const cacheKey = searchTerm.toLowerCase();

    if (searchTerm.length < MIN_SEARCH_CHARACTERS) {
      activeSearchRef.current += 1;
      setSearching(false);
      setSuggestions([]);
      setSuggestionTotal(0);

      return;
    }

    const cached = searchCacheRef.current[cacheKey];

    if (cached) {
      activeSearchRef.current += 1;
      setSuggestions(cached.suggestions);
      setSuggestionTotal(cached.total);
      setSearching(false);
      setError('');

      return;
    }

    const searchId = activeSearchRef.current + 1;
    activeSearchRef.current = searchId;
    let cancelled = false;
    const isCurrentSearch = () =>
      !cancelled &&
      activeSearchRef.current === searchId &&
      latestSearchTermRef.current === searchTerm;

    setSearching(true);
    setError('');

    const search = async () => {
      try {
        const response = await callFunction('search', { name: searchTerm });

        if (!isCurrentSearch()) {
          return;
        }

        if (response.success && response.suggestions) {
          searchCacheRef.current[cacheKey] = {
            suggestions: response.suggestions,
            total: response.suggestionTotal ?? response.suggestions.length,
          };
        }

        applyResponse(response);
      } catch (searchError) {
        if (!isCurrentSearch()) {
          return;
        }

        setError(
          searchError instanceof Error
            ? searchError.message
            : 'Unable to search Demo records.',
        );
      } finally {
        if (!cancelled && activeSearchRef.current === searchId) {
          setSearching(false);
        }
      }
    };

    void search();

    return () => {
      cancelled = true;
    };
  }, [applyResponse, callFunction, debouncedDemoName]);

  const updateDemoName = (value: string) => {
    latestSearchTermRef.current = value.trim();
    setDemoName(value);
    setSuggestions([]);
    setSuggestionTotal(0);
  };

  const attachDemo = async (record: DemoRecord) => {
    setWorking(true);

    try {
      const response = await callFunction('associate', {
        demoRecordId: record.id,
      });
      applyResponse(response);

      if (response.success) {
        latestSearchTermRef.current = '';
        setDemoName('');
        setSuggestions([]);
        setSuggestionTotal(0);
        actions.addAlert({
          type: 'success',
          title: 'Demo attached',
          message: `${record.name} is now associated to this ticket.`,
        });
      }
    } catch (attachError) {
      setError(
        attachError instanceof Error
          ? attachError.message
          : 'Unable to attach Demo record.',
      );
    } finally {
      setWorking(false);
    }
  };

  const createAndAttachDemo = async (allowDuplicate: boolean) => {
    if (!trimmedDemoName) {
      setError('Enter a Demo name first.');
      return;
    }

    setWorking(true);

    try {
      const response = await callFunction('createAndAssociate', {
        name: trimmedDemoName,
        allowDuplicate,
      });
      applyResponse(response);

      if (response.duplicateFound) {
        return;
      }

      if (response.success) {
        const createdName = response.createdRecord?.name || trimmedDemoName;
        searchCacheRef.current = {};
        latestSearchTermRef.current = '';
        setDemoName('');
        setSuggestions([]);
        setSuggestionTotal(0);
        actions.addAlert({
          type: 'success',
          title: 'Demo created',
          message: `${createdName} is now associated to this ticket.`,
        });
      }
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'Unable to create Demo record.',
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <Flex direction="column" gap="medium">
      <Heading>Demo Tags</Heading>

      {error ? (
        <Alert title="Demo tag action failed" variant="danger">
          {error}
        </Alert>
      ) : null}

      {loading ? (
        <LoadingSpinner
          label="Loading Demo tags"
          layout="centered"
          showLabel={true}
        />
      ) : tags.length ? (
        <Flex direction="row" gap="extra-small" wrap="wrap">
          {tags.map(tag => (
            <Tag key={tag.id} variant="info" inline={true}>
              {tag.name}
            </Tag>
          ))}
        </Flex>
      ) : (
        <EmptyState
          title="No Demo tags"
          layout="vertical"
          imageName="customObjects"
        >
          <Text>Add or attach a Demo below.</Text>
        </EmptyState>
      )}

      <Divider />

      <Flex direction="column" gap="small">
        <Input
          label="Demo name"
          name="demo-name"
          placeholder="Example: onboarding"
          value={demoName}
          onInput={value => {
            updateDemoName(value);
          }}
          onChange={value => {
            updateDemoName(value);
          }}
          required={true}
        />
        <Flex direction="row" gap="small" wrap="wrap">
          <Button
            type="button"
            variant={exactSuggestion ? 'secondary' : 'primary'}
            disabled={working || searchInProgress || !trimmedDemoName}
            onClick={() => {
              void createAndAttachDemo(false);
            }}
          >
            Create tag
          </Button>
        </Flex>
      </Flex>

      {searchInProgress ? (
        <LoadingSpinner
          label="Finding Demo records"
          layout="centered"
          showLabel={true}
        />
      ) : null}

      {suggestions.length ? (
        <Tile compact={true}>
          <Flex direction="column" gap="small">
            <Text format={{ fontWeight: 'demibold' }}>
              {suggestionsHeading}
            </Text>
            {suggestions.map(suggestion => (
              <Flex
                key={suggestion.id}
                direction="row"
                justify="between"
                align="center"
                gap="small"
              >
                <Flex direction="row" gap="extra-small" wrap="wrap">
                  <Text truncate={true}>{suggestion.name}</Text>
                  {suggestion.exact ? (
                    <Tag variant="warning" inline={true}>
                      Same name
                    </Tag>
                  ) : null}
                </Flex>
                <Button
                  size="xs"
                  type="button"
                  variant={suggestion.exact ? 'primary' : 'secondary'}
                  disabled={working}
                  onClick={() => {
                    void attachDemo(suggestion);
                  }}
                >
                  Attach
                </Button>
              </Flex>
            ))}
            {exactSuggestion ? (
              <Button
                type="button"
                variant="transparent"
                disabled={working}
                onClick={() => {
                  void createAndAttachDemo(true);
                }}
              >
                Create new anyway
              </Button>
            ) : null}
          </Flex>
        </Tile>
      ) : searchReady && !error ? (
        <Tile compact={true}>
          <Text>No existing Demo records found.</Text>
        </Tile>
      ) : null}
    </Flex>
  );
};
