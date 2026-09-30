-- 公開済みの版 v1.1.0 で作った DB の fixture（ADR 0344）。
-- ⛔ 手で編集しない。作り直すときは scripts/generate-upgrade-fixture.mjs を走らせる。
--
-- 作ったコード: v1.1.0（5eb6e9d98879faf5a25d43f6db9e49ed67b00c81）の @mnemora/postgres / @mnemora/core / @mnemora/testkit。
-- 埋め込み: @mnemora/testkit の DeterministicEmbeddingProvider（外部 API は使っていない）。
-- 中身: すべて合成データ（秘密・個人情報を含まない）。何を入れたかは
--       scripts/generate-upgrade-fixture.mjs の冒頭を見ること。
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-1.pgdg12+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gin; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;


--
-- Name: EXTENSION btree_gin; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gin IS 'support for indexing common datatypes in GIN';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: mnemora_lexical_coverage(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_coverage(content text, query text) RETURNS double precision
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT count(*) FILTER (
           WHERE to_tsvector('simple', mnemora_lexical_normalize(content)) @@ tq
         )::float8 / NULLIF(count(*), 0)
  FROM unnest(mnemora_lexical_query_tsqueries(query)) AS tq;
$$;


--
-- Name: mnemora_lexical_normalize(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_normalize(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT regexp_replace($1, '([[:ascii:]]+)', ' \1 ', 'g');
$_$;


--
-- Name: mnemora_lexical_query_or(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_or(text) RETURNS tsquery
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT coalesce(
    (SELECT string_agg('(' || q::text || ')', ' | ')
       FROM unnest(mnemora_lexical_query_tsqueries($1)) AS q)::tsquery,
    ''::tsquery);
$_$;


--
-- Name: mnemora_lexical_query_terms(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_terms(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT regexp_replace($1, '[^[:ascii:]]+', ' ', 'g');
$_$;


--
-- Name: mnemora_lexical_query_tsqueries(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_tsqueries(text) RETURNS tsquery[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT coalesce(array_agg(DISTINCT q), ARRAY[]::tsquery[])
  FROM (
    SELECT websearch_to_tsquery('simple', '"' || replace(t, '"', ' ') || '"') AS q
    FROM unnest(regexp_split_to_array(btrim(mnemora_lexical_query_terms($1)), '\s+')) AS t
    WHERE t <> ''
  ) s
  WHERE q::text <> '';
$_$;


--
-- Name: mnemora_lexical_tsvector(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_tsvector(content text) RETURNS tsvector
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN to_tsvector('simple', mnemora_lexical_normalize(content));
EXCEPTION WHEN program_limit_exceeded THEN
  IF SQLERRM NOT LIKE '%too long for tsvector%' THEN
    RAISE;
  END IF;
  RETURN to_tsvector('simple', mnemora_lexical_normalize(left(content, 150000)));
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _mnemora_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._mnemora_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.labels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    proposed_count integer DEFAULT 0 NOT NULL,
    registered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT labels_status_check CHECK ((status = ANY (ARRAY['registered'::text, 'proposed'::text])))
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    source_observation_id uuid,
    extractor_version text,
    content text NOT NULL,
    content_hash text NOT NULL,
    digest text NOT NULL,
    digest_source text DEFAULT 'llm'::text NOT NULL,
    provenance_kind text NOT NULL,
    provenance jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    superseded_by_id uuid,
    contested_with_id uuid,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    occurred_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    last_reinforced_at timestamp with time zone,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    strength real DEFAULT 1.0 NOT NULL,
    half_life_hours real NOT NULL,
    decay_floor_at timestamp with time zone NOT NULL,
    embedding_status text DEFAULT 'pending'::text NOT NULL,
    purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decay_base_seq bigint,
    decay_floor_seq bigint,
    half_life_recalls real,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    claim_key_subject text,
    claim_key_predicate text,
    CONSTRAINT memories_check CHECK (((provenance_kind <> ALL (ARRAY['stated'::text, 'inferred'::text])) OR (source_observation_id IS NOT NULL))),
    CONSTRAINT memories_decay_seq_non_negative CHECK ((((decay_base_seq IS NULL) OR (decay_base_seq >= 0)) AND ((decay_floor_seq IS NULL) OR (decay_floor_seq >= 0)))),
    CONSTRAINT memories_digest_source_check CHECK ((digest_source = ANY (ARRAY['llm'::text, 'fallback'::text]))),
    CONSTRAINT memories_embedding_status_check CHECK ((embedding_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT memories_half_life_range CHECK (((half_life_hours > (0)::double precision) AND (half_life_hours < 'Infinity'::real))),
    CONSTRAINT memories_half_life_recalls_range CHECK (((half_life_recalls IS NULL) OR ((half_life_recalls > (0)::double precision) AND (half_life_recalls < 'Infinity'::real)))),
    CONSTRAINT memories_provenance_kind_check CHECK ((provenance_kind = ANY (ARRAY['stated'::text, 'inferred'::text, 'consolidated'::text, 'reflected'::text, 'imported'::text]))),
    CONSTRAINT memories_provenance_kind_matches_provenance CHECK ((provenance_kind = (provenance ->> 'kind'::text))),
    CONSTRAINT memories_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'contested'::text, 'archived'::text, 'forgotten'::text]))),
    CONSTRAINT memories_strength_range CHECK (((strength > (0)::double precision) AND (strength <= (1)::double precision)))
);


--
-- Name: memory_embeddings_test_fixture_model_3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_test_fixture_model_3 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(3) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE memory_embeddings_test_fixture_model_3; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.memory_embeddings_test_fixture_model_3 IS 'mnemora:embedding-space:{"provider":"test","model":"fixture-model","dimensions":3}';


--
-- Name: memory_embeddings_testkit_deterministic_8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_testkit_deterministic_8 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(8) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE memory_embeddings_testkit_deterministic_8; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.memory_embeddings_testkit_deterministic_8 IS 'mnemora:embedding-space:{"provider":"testkit","model":"deterministic","dimensions":8}';


--
-- Name: memory_embeddings_all_spaces; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.memory_embeddings_all_spaces AS
 SELECT memory_embeddings_test_fixture_model_3.tenant_id,
    memory_embeddings_test_fixture_model_3.memory_id,
    (memory_embeddings_test_fixture_model_3.embedding)::text AS embedding_text
   FROM public.memory_embeddings_test_fixture_model_3
UNION ALL
 SELECT memory_embeddings_testkit_deterministic_8.tenant_id,
    memory_embeddings_testkit_deterministic_8.memory_id,
    (memory_embeddings_testkit_deterministic_8.embedding)::text AS embedding_text
   FROM public.memory_embeddings_testkit_deterministic_8;


--
-- Name: memory_embeddings_small_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.memory_embeddings_small_view AS
 SELECT tenant_id,
    memory_id,
    embedding,
    model,
    created_at
   FROM public.memory_embeddings_test_fixture_model_3;


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(4) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 IS 'mnemora:embedding-space:{"provider":"some-very-long-provider-name","model":"an-extremely-long-embedding-model-name-v2-large","dimensions":4}';


--
-- Name: memory_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    memory_id uuid,
    kind text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor jsonb NOT NULL,
    digest_snapshot text,
    size_before_bytes integer,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT memory_events_check CHECK (((kind <> 'events_purged'::text) OR (memory_id IS NULL))),
    CONSTRAINT memory_events_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'updated'::text, 'superseded'::text, 'archived'::text, 'forgotten'::text, 'purged'::text, 'events_purged'::text, 'restored'::text, 'unsuperseded'::text])))
);


--
-- Name: memory_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_labels (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    label_id uuid NOT NULL
);


--
-- Name: observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    external_id text,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    claimed_by text,
    attempts integer DEFAULT 0 NOT NULL,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recall_usages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recall_usages (
    tenant_id text NOT NULL,
    recall_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recalls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recalls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    query jsonb NOT NULL,
    budget jsonb,
    omitted jsonb DEFAULT '[]'::jsonb NOT NULL,
    usage jsonb NOT NULL,
    index_band jsonb NOT NULL,
    explain jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    returned_memories jsonb NOT NULL
);


--
-- Name: tenant_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_activity (
    tenant_id text NOT NULL,
    activity_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_activity_seq_non_negative CHECK ((activity_seq >= 0))
);


--
-- Name: tenant_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_settings (
    tenant_id text NOT NULL,
    default_half_life_hours real DEFAULT 720 NOT NULL,
    event_retention_days integer,
    taxonomy_mode text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decay_clock text DEFAULT 'wall'::text NOT NULL,
    default_half_life_recalls real DEFAULT 720 NOT NULL,
    CONSTRAINT tenant_settings_decay_clock_check CHECK ((decay_clock = ANY (ARRAY['wall'::text, 'activity'::text, 'either'::text]))),
    CONSTRAINT tenant_settings_default_half_life_range CHECK (((default_half_life_hours > (0)::double precision) AND (default_half_life_hours < 'Infinity'::real))),
    CONSTRAINT tenant_settings_default_half_life_recalls_range CHECK (((default_half_life_recalls > (0)::double precision) AND (default_half_life_recalls < 'Infinity'::real))),
    CONSTRAINT tenant_settings_taxonomy_mode_check CHECK ((taxonomy_mode = ANY (ARRAY['open'::text, 'strict'::text])))
);


--
-- Name: tenant_subject_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_subject_activity (
    tenant_id text NOT NULL,
    subject_id text NOT NULL,
    activity_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_subject_activity_seq_non_negative CHECK ((activity_seq >= 0))
);


--
-- Data for Name: _mnemora_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public._mnemora_migrations VALUES ('0001_init.sql', '2026-09-29 21:19:08.589285+00');
INSERT INTO public._mnemora_migrations VALUES ('0002_outbox_claim_lease_index.sql', '2026-09-29 21:19:08.600807+00');
INSERT INTO public._mnemora_migrations VALUES ('0003_period_ann_stage_index.sql', '2026-09-29 21:19:08.60205+00');
INSERT INTO public._mnemora_migrations VALUES ('0004_contested_with_index.sql', '2026-09-29 21:19:08.60344+00');
INSERT INTO public._mnemora_migrations VALUES ('0005_analyze_memories.sql', '2026-09-29 21:19:08.605032+00');
INSERT INTO public._mnemora_migrations VALUES ('0006_strength_value_range.sql', '2026-09-29 21:19:08.606485+00');
INSERT INTO public._mnemora_migrations VALUES ('0007_memories_requeue_embed_index.sql', '2026-09-29 21:19:08.607788+00');
INSERT INTO public._mnemora_migrations VALUES ('0008_memories_lexical_index.sql', '2026-09-29 21:19:08.609149+00');
INSERT INTO public._mnemora_migrations VALUES ('0009_memories_lexical_or_coverage.sql', '2026-09-29 21:19:08.610993+00');
INSERT INTO public._mnemora_migrations VALUES ('0010_memory_events_retention_index.sql', '2026-09-29 21:19:08.61348+00');
INSERT INTO public._mnemora_migrations VALUES ('0011_memory_events_kind_restored.sql', '2026-09-29 21:19:08.614919+00');
INSERT INTO public._mnemora_migrations VALUES ('0012_half_life_hours_range.sql', '2026-09-29 21:19:08.617344+00');
INSERT INTO public._mnemora_migrations VALUES ('0013_recall_returned_memories_jsonb.sql', '2026-09-29 21:19:08.618633+00');
INSERT INTO public._mnemora_migrations VALUES ('0014_observations_valid_from_until.sql', '2026-09-29 21:19:08.620102+00');
INSERT INTO public._mnemora_migrations VALUES ('0015_decay_activity_clock.sql', '2026-09-29 21:19:08.621202+00');
INSERT INTO public._mnemora_migrations VALUES ('0016_provenance_kind_matches_provenance.sql', '2026-09-29 21:19:08.624039+00');
INSERT INTO public._mnemora_migrations VALUES ('0017_provenance_kind_matches_provenance_validate.sql', '2026-09-29 21:19:08.625187+00');
INSERT INTO public._mnemora_migrations VALUES ('0018_memory_events_kind_unsuperseded.sql', '2026-09-29 21:19:08.626172+00');
INSERT INTO public._mnemora_migrations VALUES ('0019_observations_memories_attributes.sql', '2026-09-29 21:19:08.627882+00');
INSERT INTO public._mnemora_migrations VALUES ('0020_taxonomy_labels.sql', '2026-09-29 21:19:08.629324+00');
INSERT INTO public._mnemora_migrations VALUES ('0021_memories_claim_key.sql', '2026-09-29 21:19:08.632882+00');
INSERT INTO public._mnemora_migrations VALUES ('0022_embedding_zero_norm_index.sql', '2026-09-29 21:19:08.63428+00');
INSERT INTO public._mnemora_migrations VALUES ('0023_lexical_query_inner_quote_as_space.sql', '2026-09-29 21:19:08.638585+00');
INSERT INTO public._mnemora_migrations VALUES ('0024_tenant_subject_activity.sql', '2026-09-29 21:19:08.639602+00');
INSERT INTO public._mnemora_migrations VALUES ('0025_lexical_tsvector_fallback.sql', '2026-09-29 21:19:08.641175+00');


--
-- Data for Name: labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memories VALUES ('a46ec3f5-43bf-4d94-894f-8fb2de2de3f6', 'tenant-a', NULL, 'b035ff62-7ee1-40af-b367-c8437519ce6d', 'v1', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'ed6b6174b16e829904eb19e37af61bcdac066ad24d037aab65ab91746f903e4e', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.679Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b035ff62-7ee1-40af-b367-c8437519ce6d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.682+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.303+00', 'ready', NULL, '2026-09-29 21:19:08.682014+00', '2026-09-29 21:19:08.790172+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('897a41c6-5c2d-4f4d-add6-3b099d95114b', 'tenant-a', NULL, 'b0bbb193-6758-4e88-916e-f9457ab225c5', 'v1', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'd5783633ec67bfa023b1656bde0eda60589e932b2e5eb00bad51d9366c647db5', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.686Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b0bbb193-6758-4e88-916e-f9457ab225c5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.688+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.309+00', 'ready', NULL, '2026-09-29 21:19:08.687902+00', '2026-09-29 21:19:08.792318+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f470586c-8af7-4d6c-895d-3f2884d38869', 'tenant-a', NULL, '15776850-3aac-4027-9217-0d46efc78442', 'v1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'd6d0bf800f00f3c35af37625f3533767a4db7afbdc77fe18c3bc2d5987ba70c1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.693Z", "kind": "stated", "speaker": "user", "sourceObservationId": "15776850-3aac-4027-9217-0d46efc78442"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.695+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.316+00', 'ready', NULL, '2026-09-29 21:19:08.694498+00', '2026-09-29 21:19:08.794485+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('db0bc183-c53f-417c-b4c1-025cd7474242', 'tenant-a', NULL, '706d4062-1d1c-42e9-ad6f-576e962fe852', 'v1', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'edf34c29245092db70ab98057250239de4f569a113efa424ebda0f9cd882bd55', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.701Z", "kind": "stated", "speaker": "user", "sourceObservationId": "706d4062-1d1c-42e9-ad6f-576e962fe852"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.703+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.324+00', 'ready', NULL, '2026-09-29 21:19:08.702884+00', '2026-09-29 21:19:08.798903+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3a1709cc-8637-4bf5-8dee-39dada23cb30', 'tenant-a', NULL, '7f87ee73-f3de-4ecf-af32-de84ac094d6d', 'v1', 'tenant-a の記憶 7 東京 会議 プロジェクト2', '0c60f6ec18ba3a28b875b6830e0201a28a0ce0a0831c5c1cfa14d9213f4fccc3', 'tenant-a の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.709Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7f87ee73-f3de-4ecf-af32-de84ac094d6d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.711+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.332+00', 'ready', NULL, '2026-09-29 21:19:08.710753+00', '2026-09-29 21:19:08.802884+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4ce790df-4e6f-4fe7-aa9e-aa9a89f03ca9', 'tenant-a', NULL, 'c397cd2f-9a92-44c4-835f-5d2356437e9c', 'v1', 'tenant-a の記憶 12 東京 会議 プロジェクト2', '1416843979dca4b10e813c98b42e4e64184da19a8246431ca987465bf0319a69', 'tenant-a の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.734Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c397cd2f-9a92-44c4-835f-5d2356437e9c"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.736+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.357+00', 'ready', NULL, '2026-09-29 21:19:08.735638+00', '2026-09-29 21:19:08.816738+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ee33db96-defd-4b3b-949b-77a1e65dab86', 'tenant-a', NULL, '89b67872-9cf0-43c4-8995-9c0bec34a05c', 'v1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', '85fa57655dee036fb504dc9e026f2dfe383c1140f5fab5d93ff65f97a76f63c1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.738Z", "kind": "stated", "speaker": "user", "sourceObservationId": "89b67872-9cf0-43c4-8995-9c0bec34a05c"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.74+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.361+00', 'ready', NULL, '2026-09-29 21:19:08.739642+00', '2026-09-29 21:19:08.818606+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('77445d98-551f-4602-89ca-170a70a6a7d8', 'tenant-a', NULL, 'ca4b8cd8-4a09-412c-988d-43f733fa9c1e', 'v1', 'tenant-a の記憶 14 東京 会議 プロジェクト4', '566c00e514039c3cbdde42ca12af98244b4fc1d1fba5c31799c41667ccb84955', 'tenant-a の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.743Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ca4b8cd8-4a09-412c-988d-43f733fa9c1e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.745+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.366+00', 'ready', NULL, '2026-09-29 21:19:08.744505+00', '2026-09-29 21:19:08.820663+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8616afb7-77f5-48ef-b83a-8fa785553645', 'tenant-a', NULL, 'bee79136-a1c1-4665-9f61-0c65c07a7252', 'v1', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'f0b29bf3fc257d56d53bf3a40509a30894afa7846eb7397ab547ea18a3a29c38', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.748Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bee79136-a1c1-4665-9f61-0c65c07a7252"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.749+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.37+00', 'ready', NULL, '2026-09-29 21:19:08.74938+00', '2026-09-29 21:19:08.822961+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8ccbe3e6-666d-407c-8e9e-2bfc8e0d7247', 'tenant-a', NULL, 'abf7f084-e955-4de9-ba71-e2a6d2401a59', 'v1', 'tenant-a の記憶 4 東京 会議 プロジェクト4', '2d4011873ef8b25d39bde2a8122f185e9e032a938e8e1020e527a073b0930df3', 'tenant-a の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.697Z", "kind": "stated", "speaker": "user", "sourceObservationId": "abf7f084-e955-4de9-ba71-e2a6d2401a59"}', 'superseded', 'db0bc183-c53f-417c-b4c1-025cd7474242', NULL, '{}', NULL, '2026-09-29 21:19:08.699+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.32+00', 'ready', NULL, '2026-09-29 21:19:08.698799+00', '2026-09-29 21:19:08.853498+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('149ba346-7bb5-4479-b380-01b7520b1518', 'tenant-a', NULL, '6438b316-cb4c-4262-bea5-71ff5b236d50', 'v1', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'd930b5a8cf81e3b3b32791e8dae3c05994da72ef1265c035dfaf39080ed62dbe', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.705Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6438b316-cb4c-4262-bea5-71ff5b236d50"}', 'contested', NULL, 'f74cbb10-2e47-42d6-a35c-10b63088ecd8', '{}', NULL, '2026-09-29 21:19:08.707+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.328+00', 'ready', NULL, '2026-09-29 21:19:08.706788+00', '2026-09-29 21:19:08.854648+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8f215c06-e527-47ea-8294-c72de198b4ef', 'tenant-a', NULL, '9688e6e4-35a5-42e6-8a14-1b94e504f7b3', 'v1', 'tenant-a の記憶 9 東京 会議 プロジェクト4', '4c241e9f2abb28b016af405d09bb673284fc201c4fac4a039faba6f8c7e22fc3', 'tenant-a の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.721Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9688e6e4-35a5-42e6-8a14-1b94e504f7b3"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.723+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.344+00', 'ready', NULL, '2026-09-29 21:19:08.722778+00', '2026-09-29 21:19:08.857403+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c5257309-a313-4edf-8710-5239d035fd2a', 'tenant-a', NULL, '11e173f7-baf8-44b7-8475-484467f6ea3c', 'v1', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'f43c8e3670dc49dcd5e7d3d4067e6675ad27bf370e403c97f646b08db859894f', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.726Z", "kind": "stated", "speaker": "user", "sourceObservationId": "11e173f7-baf8-44b7-8475-484467f6ea3c"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.727+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.348+00', 'ready', NULL, '2026-09-29 21:19:08.727175+00', '2026-09-29 21:19:08.858418+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f1f4150b-0690-465b-9191-cdf95b34f776', 'tenant-a', NULL, 'd9b2cd55-2d66-4e0a-a6ab-022d72dff4b1', 'v1', '[purged]', '8baacaa745d740261839f6dbe908954009bba75aead9ea0901933a52379e09f4', '[purged]', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.730Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d9b2cd55-2d66-4e0a-a6ab-022d72dff4b1"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.731+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.352+00', 'ready', '2026-09-29 21:19:08.862+00', '2026-09-29 21:19:08.73137+00', '2026-09-29 21:19:08.861695+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e0081a9b-ab0b-4d2e-aace-2fb878388ee3', 'tenant-a', NULL, '8a8e162c-6163-4aed-8387-c23974b275bd', 'v1', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'd3ea19d3736314cb9c467c1662164327f232b7f4614ea76f675772f69c277594', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.668Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8a8e162c-6163-4aed-8387-c23974b275bd"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.673+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.294+00', 'ready', NULL, '2026-09-29 21:19:08.673304+00', '2026-09-29 21:19:08.787916+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('fd108a3f-04aa-49a3-ac6d-d59bac1508bc', 'tenant-a', NULL, '13e496d2-9c05-4187-9753-f204298d1171', 'v1', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'ca52ff79646f23e88b31f2cd9bab84db866daa8ee904c6ffc4f2608348e05082', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.752Z", "kind": "stated", "speaker": "user", "sourceObservationId": "13e496d2-9c05-4187-9753-f204298d1171"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.753+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.374+00', 'ready', NULL, '2026-09-29 21:19:08.753398+00', '2026-09-29 21:19:08.825121+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('9a2bcf9e-4b48-49f9-84b6-30bd672a47da', 'tenant-a', NULL, '07a628c9-16dd-476e-be91-70f344679082', 'v1', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'b143762528afffbb72a33fb24f70ebd4d19cd0cc89719dd7231a45971896fde7', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.756Z", "kind": "stated", "speaker": "user", "sourceObservationId": "07a628c9-16dd-476e-be91-70f344679082"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.757+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.378+00', 'ready', NULL, '2026-09-29 21:19:08.757067+00', '2026-09-29 21:19:08.827264+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('18825385-0942-41ff-b004-0dad509b8bf4', 'tenant-a', NULL, '6532b6b6-32de-4e31-b849-fed93b5482c1', 'v1', 'tenant-a の記憶 18 東京 会議 プロジェクト3', '6d3a158a624537a869f95ca05e650119d80bbe0cd4f796b22bc3c31ea83ada8a', 'tenant-a の記憶 18 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.759Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6532b6b6-32de-4e31-b849-fed93b5482c1"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.761+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.382+00', 'ready', NULL, '2026-09-29 21:19:08.76045+00', '2026-09-29 21:19:08.829136+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('37614f7f-d6cb-44b6-a392-d1dba00ae236', 'tenant-a', NULL, '47fcfc91-7cd0-4f0b-8b82-fed236f534c4', 'v1', 'tenant-a の記憶 19 東京 会議 プロジェクト4', '83b96ac18e746f06f8c77902fd8d7e7f3c59541caaa6ae2658298580ec04e043', 'tenant-a の記憶 19 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.763Z", "kind": "stated", "speaker": "user", "sourceObservationId": "47fcfc91-7cd0-4f0b-8b82-fed236f534c4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.764+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.385+00', 'ready', NULL, '2026-09-29 21:19:08.764244+00', '2026-09-29 21:19:08.831055+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('65826ca6-3ea1-409b-877a-cbeb6cc2178c', 'tenant-a', NULL, '274e9155-126a-40f5-8cd7-68fb71bd732d', 'v1', 'tenant-a の記憶 21 東京 会議 プロジェクト1', '4c3e66f819f467c96c28794801e751d2d4f6a9e3cd240dcfc9c3bf55c1cacc57', 'tenant-a の記憶 21 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.770Z", "kind": "stated", "speaker": "user", "sourceObservationId": "274e9155-126a-40f5-8cd7-68fb71bd732d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.771+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.392+00', 'ready', NULL, '2026-09-29 21:19:08.771171+00', '2026-09-29 21:19:08.834998+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b971cb6f-4f8f-489f-a92e-f4b5399a2b12', 'tenant-a', NULL, 'c7b3a269-f35f-4d4d-a91c-bc3da1e1cd4d', 'v1', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'b72c9757075adda4486522b26365dfd82a6af69336a4c8f52d4771450c4ce0af', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.774Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c7b3a269-f35f-4d4d-a91c-bc3da1e1cd4d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.775+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.396+00', 'ready', NULL, '2026-09-29 21:19:08.774783+00', '2026-09-29 21:19:08.836908+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('22328c13-90e3-44a3-994e-fa03fce4715c', 'tenant-a', NULL, 'baf68620-4987-489f-b538-a777dc0da466', 'v1', 'tenant-a の記憶 23 東京 会議 プロジェクト3', '26d0049fe3cf7614c786a48dd795226413a4f6260e020ea8356d457c6ff1ca3f', 'tenant-a の記憶 23 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.777Z", "kind": "stated", "speaker": "user", "sourceObservationId": "baf68620-4987-489f-b538-a777dc0da466"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.779+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.4+00', 'ready', NULL, '2026-09-29 21:19:08.778926+00', '2026-09-29 21:19:08.838847+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b1bdc4cb-d784-4f00-86b3-b8e4175b797d', 'tenant-a', NULL, 'd7b1d29b-dfd3-4468-8d02-1ecb4dc41d2e', 'v1', 'tenant-a FAIL 埋め込み失敗 東京', 'ab1702dac85d2545c823794fc8106c348a2783463f2ac321911b7721adc9a696', 'tenant-a FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.781Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d7b1d29b-dfd3-4468-8d02-1ecb4dc41d2e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.783+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.404+00', 'failed', NULL, '2026-09-29 21:19:08.782674+00', '2026-09-29 21:19:08.840419+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('65da3405-5041-492f-af51-311727b215f9', 'tenant-a', NULL, '906514f6-b0e3-4225-9915-04ef002a634f', 'v1', 'tenant-a 未埋め込み 0', '756d0ee3ef05fe980db2aa5224ed49ab257c9c10a80d33a77df32294e4a9b497', 'tenant-a 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.842Z", "kind": "stated", "speaker": "user", "sourceObservationId": "906514f6-b0e3-4225-9915-04ef002a634f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.843+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.464+00', 'pending', NULL, '2026-09-29 21:19:08.843213+00', '2026-09-29 21:19:08.843213+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c35c9683-2387-4754-8aa2-77f7f9e132bc', 'tenant-a', NULL, '043a4fc9-f13d-41bf-b5a9-d45fcd88a8ed', 'v1', 'tenant-a 未埋め込み 1', '7a1a046d3656ac2ae59f0f95d457c9c60be31eb915f2dd5cdc53822faaefdf48', 'tenant-a 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.846Z", "kind": "stated", "speaker": "user", "sourceObservationId": "043a4fc9-f13d-41bf-b5a9-d45fcd88a8ed"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.847+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.468+00', 'pending', NULL, '2026-09-29 21:19:08.847142+00', '2026-09-29 21:19:08.847142+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f5164112-4633-45d4-9b50-060b98958dd4', 'tenant-a', NULL, '75ec33b6-7e89-4d5c-9c95-862af04e2e1c', 'v1', 'tenant-a 未埋め込み 2', '899e3558b907c6a4074d675812af26d32f5a4d665344080e52cfed3d3c1218f6', 'tenant-a 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.849Z", "kind": "stated", "speaker": "user", "sourceObservationId": "75ec33b6-7e89-4d5c-9c95-862af04e2e1c"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.851+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.472+00', 'skipped', NULL, '2026-09-29 21:19:08.850548+00', '2026-09-29 21:19:08.852841+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f74cbb10-2e47-42d6-a35c-10b63088ecd8', 'tenant-a', NULL, 'c1ff49f0-2232-494e-a4eb-b7e28e7c46b1', 'v1', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'b80d062281da38b404565ed86841de51799a3a0b5a8332e8ae6c080d35716009', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.713Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c1ff49f0-2232-494e-a4eb-b7e28e7c46b1"}', 'contested', NULL, '149ba346-7bb5-4479-b380-01b7520b1518', '{}', NULL, '2026-09-29 21:19:08.715+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.336+00', 'ready', NULL, '2026-09-29 21:19:08.714585+00', '2026-09-29 21:19:08.854648+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('eceeb8ce-53c8-4f31-bd48-8a58beab0285', 'tenant-a', NULL, '8f97a6e0-4c17-4acb-b739-1e7ace4189ac', 'v1', 'tenant-a の記憶 20 東京 会議 プロジェクト0', '30b8312facf5b4d080051518335646cf1b0811d3dd74936bb276b5f511c2fda4', 'tenant-a の記憶 20 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.767Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8f97a6e0-4c17-4acb-b739-1e7ace4189ac"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.768+00', '2026-09-29 21:19:08.886+00', NULL, NULL, 1, 720, '2027-02-06 13:06:26.507+00', 'ready', NULL, '2026-09-29 21:19:08.767585+00', '2026-09-29 21:19:08.886429+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b2b96f0e-a4b7-4073-9829-a62a14b5a6a8', 'tenant-b', NULL, 'cd61fbcb-9f78-47c9-903c-1eb5cd9561a7', 'v1', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'b95da75a3bc21f8d9d823c4d001c8086e008dcc6b38e31d6ed7199e9b758b564', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.894Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cd61fbcb-9f78-47c9-903c-1eb5cd9561a7"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.895+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.516+00', 'ready', NULL, '2026-09-29 21:19:08.894987+00', '2026-09-29 21:19:08.96332+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8ee354d2-7ac4-4c57-9d74-e58d0b8c0a58', 'tenant-b', NULL, '531dac99-af73-4f54-ba8a-27372bb1dd68', 'v1', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'fef0437ad217559ad5fb73795ca3cec2b335060d36ad7ba7a9da30c623a8f0d3', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.898Z", "kind": "stated", "speaker": "user", "sourceObservationId": "531dac99-af73-4f54-ba8a-27372bb1dd68"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.899+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.52+00', 'ready', NULL, '2026-09-29 21:19:08.89887+00', '2026-09-29 21:19:08.965371+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('40156ace-7cd4-4039-acf9-329df0ab0023', 'tenant-b', NULL, 'e3c68bda-385c-4e10-b81f-698cea62de03', 'v1', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', '4e273dcb447fab0d9f4acfd5e8288bf45f0c7eb77b08b9cc0534c25d49c0c4f8', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.901Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e3c68bda-385c-4e10-b81f-698cea62de03"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.903+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.524+00', 'ready', NULL, '2026-09-29 21:19:08.902926+00', '2026-09-29 21:19:08.96745+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('006a5c23-3369-4987-a892-6ba3458bbc0f', 'tenant-b', NULL, 'e2c90494-a1bd-43e8-9d7a-69126471ce3d', 'v1', 'tenant-b の記憶 5 東京 会議 プロジェクト0', '1d9b410d61390a28c636568bbffd238b4e1012db936d587ca2fb4c25642981e9', 'tenant-b の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.909Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e2c90494-a1bd-43e8-9d7a-69126471ce3d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.91+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.531+00', 'ready', NULL, '2026-09-29 21:19:08.909796+00', '2026-09-29 21:19:08.971361+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('914f6a5a-33b7-4a76-99bc-822d89a29b7e', 'tenant-b', NULL, '51e383ab-8e8b-4306-9db1-6bddee6393de', 'v1', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'f1d4ed789aa4b33b86f74868c1d9f1efbac874dbb3cbbdd89a13eabcd6826704', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.916Z", "kind": "stated", "speaker": "user", "sourceObservationId": "51e383ab-8e8b-4306-9db1-6bddee6393de"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.918+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.539+00', 'ready', NULL, '2026-09-29 21:19:08.917499+00', '2026-09-29 21:19:08.975795+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b653da21-8dd6-4080-82dc-793dab1a8c15', 'tenant-b', NULL, '48578e71-dbce-42b5-ba25-34fb24e113ef', 'v1', 'tenant-b の記憶 12 東京 会議 プロジェクト2', '7b361a170b64a9b41f97d624b8bc1cb0f2c68950bfea639ccb5a23c4344575f8', 'tenant-b の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.935Z", "kind": "stated", "speaker": "user", "sourceObservationId": "48578e71-dbce-42b5-ba25-34fb24e113ef"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.936+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.557+00', 'ready', NULL, '2026-09-29 21:19:08.93618+00', '2026-09-29 21:19:08.985605+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('88672c65-0318-46aa-9979-efb590afe38a', 'tenant-b', NULL, 'fb54fe23-f81b-444f-80a8-69bfed6d310f', 'v1', 'tenant-b の記憶 13 東京 会議 プロジェクト3', '0dc090582bdaf2135130a122f6f926027aa9346166b076aa7ce9d878071c18f3', 'tenant-b の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.938Z", "kind": "stated", "speaker": "user", "sourceObservationId": "fb54fe23-f81b-444f-80a8-69bfed6d310f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.94+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.561+00', 'ready', NULL, '2026-09-29 21:19:08.940166+00', '2026-09-29 21:19:08.987642+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e06b5dcf-dfa0-4051-922c-f17c74d72651', 'tenant-b', NULL, '4786d953-f28f-4973-bce3-5ba5173214f0', 'v1', 'tenant-b の記憶 15 東京 会議 プロジェクト0', '159e45fbd8a5ffaff4ae601883d4d60fd353ceca26759a1642630065cef3b241', 'tenant-b の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.946Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4786d953-f28f-4973-bce3-5ba5173214f0"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.947+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.568+00', 'ready', NULL, '2026-09-29 21:19:08.947324+00', '2026-09-29 21:19:08.991712+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b8aed883-24b6-4e41-b086-5fdfc3f0c661', 'tenant-b', NULL, '75674ce3-6231-4247-a551-527d9494337f', 'v1', 'tenant-b の記憶 4 東京 会議 プロジェクト4', '5940641d2d369c2cc336a4e7e0dfe324af8bd43c6c6bb540111ea25536b9f590', 'tenant-b の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.905Z", "kind": "stated", "speaker": "user", "sourceObservationId": "75674ce3-6231-4247-a551-527d9494337f"}', 'superseded', '006a5c23-3369-4987-a892-6ba3458bbc0f', NULL, '{}', NULL, '2026-09-29 21:19:08.907+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.528+00', 'ready', NULL, '2026-09-29 21:19:08.90641+00', '2026-09-29 21:19:09.008629+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('06e363fc-41f9-423b-84cf-57c3948d536f', 'tenant-b', NULL, '43893183-ea94-4fa3-a2d3-a3931f62800b', 'v1', 'tenant-b の記憶 6 東京 会議 プロジェクト1', '25dbc01aa826c3caa1c214b61d630f769615fc5a4f74f62be2b71c2a659e3fa8', 'tenant-b の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.912Z", "kind": "stated", "speaker": "user", "sourceObservationId": "43893183-ea94-4fa3-a2d3-a3931f62800b"}', 'contested', NULL, '1ecb2047-167b-45a7-af37-7559bd95ece3', '{}', NULL, '2026-09-29 21:19:08.914+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.535+00', 'ready', NULL, '2026-09-29 21:19:08.913729+00', '2026-09-29 21:19:09.009444+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d1c301c6-60d9-48f1-bf66-ab932c3a9f26', 'tenant-b', NULL, '7c07ab26-9013-43f2-a0b8-0d3575981279', 'v1', 'tenant-b の記憶 9 東京 会議 プロジェクト4', '1e67543f28e3ecb46017a56947f528295cfd849f37bbff911216c8f13f03cb45', 'tenant-b の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.924Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7c07ab26-9013-43f2-a0b8-0d3575981279"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.925+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.546+00', 'ready', NULL, '2026-09-29 21:19:08.925181+00', '2026-09-29 21:19:09.011701+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('95212a43-882e-4e2c-ac32-b18f7877d654', 'tenant-b', NULL, '56839a6d-76ec-41c8-9b00-60c5d15c535f', 'v1', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'e3ce75d1b42cf68db24819b6cf5a26b4168b236f492bda9ec4f44f99baf6e59f', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.928Z", "kind": "stated", "speaker": "user", "sourceObservationId": "56839a6d-76ec-41c8-9b00-60c5d15c535f"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.929+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.55+00', 'ready', NULL, '2026-09-29 21:19:08.928966+00', '2026-09-29 21:19:09.012474+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('43ae5893-9b66-4023-aac5-500a87b70b05', 'tenant-b', NULL, '8a6b99cc-bb57-48f2-ba45-892febca79a2', 'v1', '[purged]', '624794e8e55d99b8d71021f048790ff041d1bfb438372d59bcdfa91e5e3b0bcd', '[purged]', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.931Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8a6b99cc-bb57-48f2-ba45-892febca79a2"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.933+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.554+00', 'ready', '2026-09-29 21:19:09.015+00', '2026-09-29 21:19:08.932593+00', '2026-09-29 21:19:09.014971+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('78f77025-74b7-4f26-9f7f-42ee84b9744c', 'tenant-b', NULL, '401a6b2a-e77e-452d-9180-b6cc1e6e793a', 'v1', 'tenant-b の記憶 14 東京 会議 プロジェクト4', '8a607cfc5964eaf69142f32afe35b75600e27d38176864ada321967ce349bc64', 'tenant-b の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.942Z", "kind": "stated", "speaker": "user", "sourceObservationId": "401a6b2a-e77e-452d-9180-b6cc1e6e793a"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.944+00', '2026-09-29 21:19:09.029+00', NULL, NULL, 1, 720, '2027-02-06 13:06:26.65+00', 'ready', NULL, '2026-09-29 21:19:08.943496+00', '2026-09-29 21:19:09.028702+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('34bc6c50-4daf-455e-93a8-c0810d9af8d2', 'tenant-b', NULL, '8efb7ec9-c77a-48e5-9262-2a0ca64d64e4', 'v1', 'tenant-b の記憶 0 東京 会議 プロジェクト0', '081a9a9f113b084d0ccebeb4e29f753910bca11b2e4e20168eca50413e85a174', 'tenant-b の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.890Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8efb7ec9-c77a-48e5-9262-2a0ca64d64e4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.891+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.512+00', 'ready', NULL, '2026-09-29 21:19:08.891239+00', '2026-09-29 21:19:08.961079+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e2081c0b-cf18-4bbe-9a9c-44ef2a48dabe', 'tenant-b', NULL, 'f665cf43-f902-4eef-a8df-63b6e7439b8a', 'v1', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'b8c54c018860dad1bd5d84c2883f7deef7dba67a41562560b7454f3565547826', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.950Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f665cf43-f902-4eef-a8df-63b6e7439b8a"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.951+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.572+00', 'ready', NULL, '2026-09-29 21:19:08.950707+00', '2026-09-29 21:19:08.993495+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e5b7d4de-20f6-49f9-9c9f-f8d7b52db74a', 'tenant-b', NULL, 'f31c9fef-4429-4f70-ab3b-58b430ee8f79', 'v1', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', '512794d1b4203897a59658ba1c10d0d4ff10f5d69627a6dffa186e0a86c02feb', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.953Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f31c9fef-4429-4f70-ab3b-58b430ee8f79"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.954+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.575+00', 'ready', NULL, '2026-09-29 21:19:08.953942+00', '2026-09-29 21:19:08.995217+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a557b10f-571d-481a-ab40-f77579405ccc', 'tenant-b', NULL, 'e37b2220-cd40-4c73-abb9-d41c35d034b1', 'v1', 'tenant-b FAIL 埋め込み失敗 東京', 'dca6507a3912ad169580cf2764c29ddf080a9cbf73c32d7ddf16429d985d35ef', 'tenant-b FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.956Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e37b2220-cd40-4c73-abb9-d41c35d034b1"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:08.957+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.578+00', 'failed', NULL, '2026-09-29 21:19:08.957364+00', '2026-09-29 21:19:08.997034+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('370a2fd7-0122-4f2c-8067-33b2105b749d', 'tenant-b', NULL, '43a023e0-7cc6-4ea2-be6e-5574676665b2', 'v1', 'tenant-b 未埋め込み 0', '4f033a8ab5dff18cce4bfac1ffa04151f80b45e51806b9cebeca92a143ae6386', 'tenant-b 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.998Z", "kind": "stated", "speaker": "user", "sourceObservationId": "43a023e0-7cc6-4ea2-be6e-5574676665b2"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.621+00', 'pending', NULL, '2026-09-29 21:19:08.999695+00', '2026-09-29 21:19:08.999695+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c671fe01-0eb3-4ec6-a4d3-139226e4f756', 'tenant-b', NULL, 'bfdd12a5-6077-42ad-a650-d14d2a410282', 'v1', 'tenant-b 未埋め込み 1', '9d77f4b53475fe24e31aaa3bcdc02aa1a0786c37888dcee783f146c4aae191e2', 'tenant-b 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.002Z", "kind": "stated", "speaker": "user", "sourceObservationId": "bfdd12a5-6077-42ad-a650-d14d2a410282"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.003+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.624+00', 'pending', NULL, '2026-09-29 21:19:09.003086+00', '2026-09-29 21:19:09.003086+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a6369cc6-0d23-4855-b2b2-9c17bb601ac4', 'tenant-b', NULL, '6d3cc096-b9de-480c-91e2-4b5ac3fcdf83', 'v1', 'tenant-b 未埋め込み 2', '318fb30d6dda58f1c972e4779c59979fbd926637878da937d6155ac62a286d02', 'tenant-b 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.005Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6d3cc096-b9de-480c-91e2-4b5ac3fcdf83"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.006+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.627+00', 'skipped', NULL, '2026-09-29 21:19:09.006237+00', '2026-09-29 21:19:09.008092+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1ecb2047-167b-45a7-af37-7559bd95ece3', 'tenant-b', NULL, 'f3cf3f85-9c47-4e80-b705-933d585658f9', 'v1', 'tenant-b の記憶 8 東京 会議 プロジェクト3', '03f24fe74d5d2e3d56878e412d3b0daf983f57c46d18f1bf25917b76cf7ef9f6', 'tenant-b の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:08.920Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f3cf3f85-9c47-4e80-b705-933d585658f9"}', 'forgotten', NULL, '06e363fc-41f9-423b-84cf-57c3948d536f', '{}', NULL, '2026-09-29 21:19:08.922+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.543+00', 'ready', NULL, '2026-09-29 21:19:08.921476+00', '2026-09-29 21:19:09.019329+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ad31ac07-561f-4ab2-9ac4-f4af9f071447', 'tenant-c', NULL, '644d968f-6494-46ea-8a12-ff4e074ffe92', 'v1', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'f97a8b4d6e8a9c4b9cc08f892895a26c5150d4dc14b0da37a299e97b759312b2', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.034Z", "kind": "stated", "speaker": "user", "sourceObservationId": "644d968f-6494-46ea-8a12-ff4e074ffe92"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.035+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.656+00', 'ready', NULL, '2026-09-29 21:19:09.035343+00', '2026-09-29 21:19:09.074749+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('529fec4e-b51e-4354-81f5-915f551fc090', 'tenant-c', NULL, '9196f304-ce8b-4c1c-ac89-c6b43c024e4e', 'v1', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', '94612eb1b4f64fa932a1d3db6feb48231cb950d9ffd00939776db4cf1eb29c26', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.041Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9196f304-ce8b-4c1c-ac89-c6b43c024e4e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.042+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.663+00', 'ready', NULL, '2026-09-29 21:19:09.041577+00', '2026-09-29 21:19:09.078298+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('50208925-5184-435d-a475-8e89257cbc8c', 'tenant-c', NULL, '09766e6d-407a-4bae-a3e9-6d6babf94119', 'v1', 'tenant-c の記憶 7 東京 会議 プロジェクト2', '8c524a04f68127aef3b7b341e63ac27629ee3136f0ef9da63934e27c206cb419', 'tenant-c の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.053Z", "kind": "stated", "speaker": "user", "sourceObservationId": "09766e6d-407a-4bae-a3e9-6d6babf94119"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.054+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.675+00', 'ready', NULL, '2026-09-29 21:19:09.054161+00', '2026-09-29 21:19:09.085231+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6c7d210c-ea61-4443-97d8-7678c838e050', 'tenant-c', NULL, '0c94269a-8cad-4080-8b0f-575cc0d63c8a', 'v1', 'tenant-c の記憶 4 東京 会議 プロジェクト4', '81f4ee70cb39ef24184d9447f8e119462e2b333831286169f12207dd00f50327', 'tenant-c の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.044Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0c94269a-8cad-4080-8b0f-575cc0d63c8a"}', 'superseded', '80b4062f-7499-4a58-b4eb-754ec4780413', NULL, '{}', NULL, '2026-09-29 21:19:09.045+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.666+00', 'ready', NULL, '2026-09-29 21:19:09.045033+00', '2026-09-29 21:19:09.104981+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e1269471-f54e-4110-888a-efba39fde35a', 'tenant-c', NULL, '756cd911-410b-449b-b958-134c6e625b2c', 'v1', 'tenant-c の記憶 6 東京 会議 プロジェクト1', '1349732c0ebd9031ddc9bcae41973c5c6b6ab2f76e2179b5374ad6957af1fe87', 'tenant-c の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.050Z", "kind": "stated", "speaker": "user", "sourceObservationId": "756cd911-410b-449b-b958-134c6e625b2c"}', 'contested', NULL, '5087e2e0-e935-4722-9c97-ea12083cc089', '{}', NULL, '2026-09-29 21:19:09.051+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.672+00', 'ready', NULL, '2026-09-29 21:19:09.050993+00', '2026-09-29 21:19:09.105764+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('80b4062f-7499-4a58-b4eb-754ec4780413', 'tenant-c', NULL, '610153bf-c054-4e78-8fb5-7d3e951402b5', 'v1', 'tenant-c の記憶 5 東京 会議 プロジェクト0', '0996fea87104119898e02a0d9962c82a2dfe8c52e32205dc818277bcf516daf6', 'tenant-c の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.047Z", "kind": "stated", "speaker": "user", "sourceObservationId": "610153bf-c054-4e78-8fb5-7d3e951402b5"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.048+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.669+00', 'ready', NULL, '2026-09-29 21:19:09.048102+00', '2026-09-29 21:19:09.115122+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('0896592a-b088-4259-b675-f294ec3f24ae', 'tenant-c', NULL, '9bcb410b-077c-43da-b04d-e58368dc38aa', 'v1', 'tenant-c の記憶 2 東京 会議 プロジェクト2', '2576291adf7ad31335c6494eb95a197053599c859b1067bc5f6b08c63fbd8fc2', 'tenant-c の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.037Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9bcb410b-077c-43da-b04d-e58368dc38aa"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.039+00', '2026-09-29 21:19:09.124+00', NULL, NULL, 1, 720, '2027-02-06 13:06:26.745+00', 'ready', NULL, '2026-09-29 21:19:09.038448+00', '2026-09-29 21:19:09.123597+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('803c4e49-e08f-40ff-bf33-1677351cdde8', 'tenant-c', NULL, '0facdd38-35cc-4543-965d-ae3ae08040fa', 'v1', 'tenant-c の記憶 0 東京 会議 プロジェクト0', '0d78da8c6a4e2de262064e70959180f45578ab348746afc04814736d3ec98420', 'tenant-c の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.031Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0facdd38-35cc-4543-965d-ae3ae08040fa"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.032+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.653+00', 'ready', NULL, '2026-09-29 21:19:09.032152+00', '2026-09-29 21:19:09.072811+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1a9e0273-c36f-45ed-89eb-4106208cd32d', 'tenant-c', NULL, '7688f2bb-c599-4ffd-9781-2ef918cce1d1', 'v1', 'tenant-c FAIL 埋め込み失敗 東京', '985f97e69b2fc62b500ebd50803bce5a72393d80852f55d01d88a21002fd7746', 'tenant-c FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.069Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7688f2bb-c599-4ffd-9781-2ef918cce1d1"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.07+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.691+00', 'failed', NULL, '2026-09-29 21:19:09.069541+00', '2026-09-29 21:19:09.093874+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6023da71-4646-4143-8d63-6021c08c06b7', 'tenant-c', NULL, 'ac3a6801-99b0-43fc-acba-3b2fd5dedf2e', 'v1', 'tenant-c 未埋め込み 0', 'dbbed7a9da3bc87703ee74ec7fcbae128292a28245a094e1e7fe55b2e761766d', 'tenant-c 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.095Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ac3a6801-99b0-43fc-acba-3b2fd5dedf2e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.097+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.718+00', 'pending', NULL, '2026-09-29 21:19:09.096434+00', '2026-09-29 21:19:09.096434+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('03c2f3f3-f14c-4b43-8b71-ea306b03de60', 'tenant-c', NULL, '57f33b89-4937-47dc-ab90-21ad5840cbb9', 'v1', 'tenant-c 未埋め込み 1', '6fef40b085316dc1f9517118e7701e59fddc1231ce2b4b7b03aaf45936697d74', 'tenant-c 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.099Z", "kind": "stated", "speaker": "user", "sourceObservationId": "57f33b89-4937-47dc-ab90-21ad5840cbb9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.1+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.721+00', 'pending', NULL, '2026-09-29 21:19:09.09961+00', '2026-09-29 21:19:09.09961+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('423c076d-ec57-4c09-baa3-f598d7b15a75', 'tenant-c', NULL, '10c5dbda-ab9f-473c-ba76-337787c1c29e', 'v1', 'tenant-c 未埋め込み 2', 'd4169a93c46303e6cc20af167d50c6ffb9c86896911949620cd36e561554b6c1', 'tenant-c 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.102Z", "kind": "stated", "speaker": "user", "sourceObservationId": "10c5dbda-ab9f-473c-ba76-337787c1c29e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.103+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.724+00', 'skipped', NULL, '2026-09-29 21:19:09.102688+00', '2026-09-29 21:19:09.104424+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5087e2e0-e935-4722-9c97-ea12083cc089', 'tenant-c', NULL, 'd5ddf8d1-4f81-49f3-bac9-852956fb3693', 'v1', 'tenant-c の記憶 8 東京 会議 プロジェクト3', '27955d03f0fb4db217579a1e5dbf74beed76d3f569305b1ab21cd24db6b92e36', 'tenant-c の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.056Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d5ddf8d1-4f81-49f3-bac9-852956fb3693"}', 'contested', NULL, 'e1269471-f54e-4110-888a-efba39fde35a', '{}', NULL, '2026-09-29 21:19:09.057+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.678+00', 'ready', NULL, '2026-09-29 21:19:09.057215+00', '2026-09-29 21:19:09.105764+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('9116da75-f860-4d17-89a4-2f64e54d8ce6', 'tenant-c', NULL, '749cde64-66b2-4a6d-ad6a-bd4fefcca044', 'v1', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'd8961ae07e5a93b6b0dc84ea6ee4aa46d7a585e6dfcbda5aaddc38a2ce3974b6', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.059Z", "kind": "stated", "speaker": "user", "sourceObservationId": "749cde64-66b2-4a6d-ad6a-bd4fefcca044"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.06+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.681+00', 'ready', NULL, '2026-09-29 21:19:09.060246+00', '2026-09-29 21:19:09.107959+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2d300c70-9a57-4349-a006-717b3abfc57c', 'tenant-c', NULL, 'e2263584-7278-4538-bb60-e6adb182d2b4', 'v1', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'be6295fd3fa665a4400e99e456e7ac4a6311b950abd5ab167494cf5cf1661dc4', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.062Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e2263584-7278-4538-bb60-e6adb182d2b4"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.063+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.684+00', 'ready', NULL, '2026-09-29 21:19:09.063315+00', '2026-09-29 21:19:09.108666+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d76c3b7e-2b3c-49b3-8be7-303230c6584a', 'tenant-c', NULL, '4e969f2f-f3cf-4725-bf0f-6652e6b6bbb7', 'v1', '[purged]', '90508b50cef379d5c03fa9f0c876b432c0e3fe77e30b0a0ccc82349c9d4a406f', '[purged]', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.065Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4e969f2f-f3cf-4725-bf0f-6652e6b6bbb7"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.067+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.688+00', 'ready', '2026-09-29 21:19:09.111+00', '2026-09-29 21:19:09.066477+00', '2026-09-29 21:19:09.111026+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('114fa41b-0db7-40c6-a5bf-f70e8d14ce0a', 'tenant-a2', NULL, '288ae0e3-74ca-4be1-bd12-c20ade29adc9', 'v1', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'a785d27623732af65fc0f05c80ea5e8638cd85eb944016167297bd92393c0331', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.135Z", "kind": "stated", "speaker": "user", "sourceObservationId": "288ae0e3-74ca-4be1-bd12-c20ade29adc9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.136+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.757+00', 'ready', NULL, '2026-09-29 21:19:09.136064+00', '2026-09-29 21:19:09.166705+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ec8f5a3c-0b36-4080-a8e4-bc7e3d15c5ea', 'tenant-a2', NULL, '0dd58802-84bf-4811-a64c-b7be9adeb8c5', 'v1', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', '2ff9054147bebbf3ab7b87786763739a75177d4a5b1f441bea040bf1eca421f4', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.141Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0dd58802-84bf-4811-a64c-b7be9adeb8c5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.142+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.763+00', 'ready', NULL, '2026-09-29 21:19:09.142098+00', '2026-09-29 21:19:09.170182+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('9f24e4e1-0c22-45c0-9f03-b834cf4a5275', 'tenant-a2', NULL, '10880072-5972-4e26-9fd7-e27e3dfdd759', 'v1', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', '914fb28b9e9744124fe125428a1d2ccdd0770428843fc02994496676178c35ee', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.147Z", "kind": "stated", "speaker": "user", "sourceObservationId": "10880072-5972-4e26-9fd7-e27e3dfdd759"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.149+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.77+00', 'ready', NULL, '2026-09-29 21:19:09.148461+00', '2026-09-29 21:19:09.173861+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e2768f28-5722-457e-aadf-7918c1f6af0e', 'tenant-a2', NULL, 'd6393d8b-3482-4669-860b-59b9cc83e922', 'v1', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', '24ab90528718614c3e988124ed86cb1748700763560be7ef27c8bf4b5dcfd1ab', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.138Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d6393d8b-3482-4669-860b-59b9cc83e922"}', 'superseded', 'ec8f5a3c-0b36-4080-a8e4-bc7e3d15c5ea', NULL, '{}', NULL, '2026-09-29 21:19:09.139+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.76+00', 'ready', NULL, '2026-09-29 21:19:09.139137+00', '2026-09-29 21:19:09.189687+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('04049d67-9084-4e11-8721-2e6c76210229', 'tenant-a2', NULL, '632f2625-a6f9-4ffe-b9d8-4c01e6ad96c4', 'v1', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', '7592207a458219fa91a20d15fb9715e0462c1b13647e460421449a8734cc3f3b', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.144Z", "kind": "stated", "speaker": "user", "sourceObservationId": "632f2625-a6f9-4ffe-b9d8-4c01e6ad96c4"}', 'contested', NULL, 'da9fe5f8-52b7-4d40-8de7-1513742246ec', '{}', NULL, '2026-09-29 21:19:09.145+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.766+00', 'ready', NULL, '2026-09-29 21:19:09.145225+00', '2026-09-29 21:19:09.19048+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2ea3bcd6-8d52-44b6-84ea-3e1c2d815346', 'tenant-a2', NULL, '538f5b86-ad57-4764-b18d-78c1d876697a', 'v1', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', '4cf1d599eeca369fd9803aad38e37386c99caf014b2df0588842e802cb851f62', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.132Z", "kind": "stated", "speaker": "user", "sourceObservationId": "538f5b86-ad57-4764-b18d-78c1d876697a"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.133+00', '2026-09-29 21:19:09.21+00', NULL, NULL, 1, 720, '2027-02-06 13:06:26.831+00', 'ready', NULL, '2026-09-29 21:19:09.132852+00', '2026-09-29 21:19:09.209575+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('496090f5-d621-4c95-ada9-f7013ab52acc', 'tenant-a2', NULL, '22d87971-b16d-40cd-9c9d-ef9b1220512d', 'v1', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'cc6965c4ce873014f25affb39c4d6773bd8fb57667bfa6de70490b30eeb8b9c2', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.126Z", "kind": "stated", "speaker": "user", "sourceObservationId": "22d87971-b16d-40cd-9c9d-ef9b1220512d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.127+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.748+00', 'ready', NULL, '2026-09-29 21:19:09.126681+00', '2026-09-29 21:19:09.160197+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6adbf50b-61e7-4b03-a54a-f9c4d2960d73', 'tenant-a2', NULL, 'be096dd0-5a06-465f-ab87-0ea845b68130', 'v1', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', '98db05eaf2b468995ca8ddfb04238b6a3f78950faff175f1bfb6be45a8249e43', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.129Z", "kind": "stated", "speaker": "user", "sourceObservationId": "be096dd0-5a06-465f-ab87-0ea845b68130"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.13+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.751+00', 'ready', NULL, '2026-09-29 21:19:09.129776+00', '2026-09-29 21:19:09.162901+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b4ef02b5-0add-4954-a753-17beef9a4947', 'tenant-a2', NULL, 'c60394fd-2f6c-4c4f-b73c-3171617dbab8', 'v1', 'tenant-a2 FAIL 埋め込み失敗 東京', '72456a5d7a68e3f7d1e7d082bd8429d137478336dc0b7ab44c25aae0508cf9c7', 'tenant-a2 FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.156Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c60394fd-2f6c-4c4f-b73c-3171617dbab8"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.158+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.779+00', 'failed', NULL, '2026-09-29 21:19:09.157413+00', '2026-09-29 21:19:09.178693+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('47251278-3368-477b-b190-caefb117fe06', 'tenant-a2', NULL, '9deda963-7bce-4907-bb6f-80c07a63a2b6', 'v1', 'tenant-a2 未埋め込み 2', '361bf58e0bbb5d4804764e21fd48bddde845290c4fcd3281b746852036325696', 'tenant-a2 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.186Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9deda963-7bce-4907-bb6f-80c07a63a2b6"}', 'active', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.187+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.808+00', 'skipped', NULL, '2026-09-29 21:19:09.187321+00', '2026-09-29 21:19:09.18913+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('da9fe5f8-52b7-4d40-8de7-1513742246ec', 'tenant-a2', NULL, '16fc8e75-9ee5-43bd-9dd3-e75595f71ae6', 'v1', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', '97de39f5fe1e8a6b2164b4726c2ae28bd112a4222632a171a6a79d866131fa79', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.151Z", "kind": "stated", "speaker": "user", "sourceObservationId": "16fc8e75-9ee5-43bd-9dd3-e75595f71ae6"}', 'contested', NULL, '04049d67-9084-4e11-8721-2e6c76210229', '{}', NULL, '2026-09-29 21:19:09.152+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.773+00', 'ready', NULL, '2026-09-29 21:19:09.151416+00', '2026-09-29 21:19:09.19048+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b16c41a7-e0dd-48bf-a5e9-17732265cfb4', 'tenant-a2', NULL, '9c25633b-0a84-40ba-8113-43263ffa210f', 'v1', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'f43da00aa2d66eb30de895210fc22e5cba0548b91eb41edc808208389480c46c', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.153Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9c25633b-0a84-40ba-8113-43263ffa210f"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.155+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.776+00', 'ready', NULL, '2026-09-29 21:19:09.154308+00', '2026-09-29 21:19:09.192631+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('adf5081f-804e-4f4f-ae6f-19de33396c47', 'tenant-a2', NULL, '32cb7fd4-9db9-4344-ad1e-b812e31b4487', 'v1', 'tenant-a2 未埋め込み 0', '096af51a3f55ac6f12d4f7ae6b8dadd71299c722c9f56ac9764db3bd05d536e4', 'tenant-a2 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.180Z", "kind": "stated", "speaker": "user", "sourceObservationId": "32cb7fd4-9db9-4344-ad1e-b812e31b4487"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.181+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.802+00', 'pending', NULL, '2026-09-29 21:19:09.181015+00', '2026-09-29 21:19:09.193376+00', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f1027e42-06bb-4ba2-82bf-d4949f56d5e9', 'tenant-a2', NULL, 'b015484f-449f-4a8c-a3ca-1c2f8f76ee21', 'v1', '[purged]', 'e78005a62ce1fe1dc602590187cd521751267c830e60191f8b6622dafb10a298', '[purged]', 'llm', 'stated', '{"at": "2026-09-29T21:19:09.183Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b015484f-449f-4a8c-a3ca-1c2f8f76ee21"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-29 21:19:09.184+00', NULL, NULL, NULL, 1, 720, '2027-02-06 13:06:26.805+00', 'pending', '2026-09-29 21:19:09.196+00', '2026-09-29 21:19:09.184218+00', '2026-09-29 21:19:09.195871+00', NULL, NULL, NULL, '{}', NULL, NULL);


--
-- Data for Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '803c4e49-e08f-40ff-bf33-1677351cdde8', '[16,772,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.072118+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'ad31ac07-561f-4ab2-9ac4-f4af9f071447', '[16,773,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.074408+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '0896592a-b088-4259-b675-f294ec3f24ae', '[16,774,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.076163+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '529fec4e-b51e-4354-81f5-915f551fc090', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.077941+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '6c7d210c-ea61-4443-97d8-7678c838e050', '[16,776,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.079702+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '80b4062f-7499-4a58-b4eb-754ec4780413', '[16,777,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.081417+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'e1269471-f54e-4110-888a-efba39fde35a', '[16,778,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.083124+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '50208925-5184-435d-a475-8e89257cbc8c', '[16,779,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.084901+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '5087e2e0-e935-4722-9c97-ea12083cc089', '[16,780,45,210]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.086591+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '9116da75-f860-4d17-89a4-2f64e54d8ce6', '[16,781,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.088272+00');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '2d300c70-9a57-4349-a006-717b3abfc57c', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-29 21:19:09.090199+00');


--
-- Data for Name: memory_embeddings_test_fixture_model_3; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'e0081a9b-ab0b-4d2e-aace-2fb878388ee3', '[677,880,478]', 'fixture-model', '2026-09-29 21:19:08.787057+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'a46ec3f5-43bf-4d94-894f-8fb2de2de3f6', '[678,881,478]', 'fixture-model', '2026-09-29 21:19:08.789793+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '897a41c6-5c2d-4f4d-add6-3b099d95114b', '[679,882,478]', 'fixture-model', '2026-09-29 21:19:08.7919+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'f470586c-8af7-4d6c-895d-3f2884d38869', '[0,0,0]', 'fixture-model', '2026-09-29 21:19:08.794067+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '8ccbe3e6-666d-407c-8e9e-2bfc8e0d7247', '[681,884,478]', 'fixture-model', '2026-09-29 21:19:08.796049+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'db0bc183-c53f-417c-b4c1-025cd7474242', '[677,885,478]', 'fixture-model', '2026-09-29 21:19:08.798156+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '149ba346-7bb5-4479-b380-01b7520b1518', '[678,886,478]', 'fixture-model', '2026-09-29 21:19:08.800542+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '3a1709cc-8637-4bf5-8dee-39dada23cb30', '[679,887,478]', 'fixture-model', '2026-09-29 21:19:08.802477+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'f74cbb10-2e47-42d6-a35c-10b63088ecd8', '[680,888,478]', 'fixture-model', '2026-09-29 21:19:08.804463+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '8f215c06-e527-47ea-8294-c72de198b4ef', '[681,889,478]', 'fixture-model', '2026-09-29 21:19:08.810167+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c5257309-a313-4edf-8710-5239d035fd2a', '[0,0,0]', 'fixture-model', '2026-09-29 21:19:08.812388+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '4ce790df-4e6f-4fe7-aa9e-aa9a89f03ca9', '[855,769,464]', 'fixture-model', '2026-09-29 21:19:08.816195+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'ee33db96-defd-4b3b-949b-77a1e65dab86', '[855,770,465]', 'fixture-model', '2026-09-29 21:19:08.818237+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '77445d98-551f-4602-89ca-170a70a6a7d8', '[855,771,466]', 'fixture-model', '2026-09-29 21:19:08.820277+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '8616afb7-77f5-48ef-b83a-8fa785553645', '[855,767,467]', 'fixture-model', '2026-09-29 21:19:08.82257+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'fd108a3f-04aa-49a3-ac6d-d59bac1508bc', '[855,768,468]', 'fixture-model', '2026-09-29 21:19:08.824725+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '9a2bcf9e-4b48-49f9-84b6-30bd672a47da', '[0,0,0]', 'fixture-model', '2026-09-29 21:19:08.826878+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '18825385-0942-41ff-b004-0dad509b8bf4', '[855,770,470]', 'fixture-model', '2026-09-29 21:19:08.828756+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '37614f7f-d6cb-44b6-a392-d1dba00ae236', '[855,771,471]', 'fixture-model', '2026-09-29 21:19:08.830681+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'eceeb8ce-53c8-4f31-bd48-8a58beab0285', '[855,768,462]', 'fixture-model', '2026-09-29 21:19:08.832623+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '65826ca6-3ea1-409b-877a-cbeb6cc2178c', '[855,769,463]', 'fixture-model', '2026-09-29 21:19:08.834614+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'b971cb6f-4f8f-489f-a92e-f4b5399a2b12', '[855,770,464]', 'fixture-model', '2026-09-29 21:19:08.836498+00');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '22328c13-90e3-44a3-994e-fa03fce4715c', '[855,771,465]', 'fixture-model', '2026-09-29 21:19:08.838433+00');


--
-- Data for Name: memory_embeddings_testkit_deterministic_8; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '34bc6c50-4daf-455e-93a8-c0810d9af8d2', '[839,69,404,38,174,703,638,168]', 'deterministic', '2026-09-29 21:19:08.960612+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'b2b96f0e-a4b7-4073-9829-a62a14b5a6a8', '[839,69,404,39,174,704,638,168]', 'deterministic', '2026-09-29 21:19:08.962926+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '8ee354d2-7ac4-4c57-9d74-e58d0b8c0a58', '[839,69,404,40,174,705,638,168]', 'deterministic', '2026-09-29 21:19:08.964871+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '40156ace-7cd4-4039-acf9-329df0ab0023', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-29 21:19:08.967077+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'b8aed883-24b6-4e41-b086-5fdfc3f0c661', '[839,69,404,42,174,707,638,168]', 'deterministic', '2026-09-29 21:19:08.968894+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '006a5c23-3369-4987-a892-6ba3458bbc0f', '[839,69,404,38,174,708,638,168]', 'deterministic', '2026-09-29 21:19:08.970905+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '06e363fc-41f9-423b-84cf-57c3948d536f', '[839,69,404,39,174,709,638,168]', 'deterministic', '2026-09-29 21:19:08.973047+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '914f6a5a-33b7-4a76-99bc-822d89a29b7e', '[839,69,404,40,174,710,638,168]', 'deterministic', '2026-09-29 21:19:08.975341+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '1ecb2047-167b-45a7-af37-7559bd95ece3', '[839,69,404,41,174,711,638,168]', 'deterministic', '2026-09-29 21:19:08.977455+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'd1c301c6-60d9-48f1-bf66-ab932c3a9f26', '[839,69,404,42,174,712,638,168]', 'deterministic', '2026-09-29 21:19:08.979481+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '95212a43-882e-4e2c-ac32-b18f7877d654', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-29 21:19:08.98128+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'b653da21-8dd6-4080-82dc-793dab1a8c15', '[218,229,101,23,993,197,634,691]', 'deterministic', '2026-09-29 21:19:08.985213+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '88672c65-0318-46aa-9979-efb590afe38a', '[218,229,101,23,994,197,635,691]', 'deterministic', '2026-09-29 21:19:08.987244+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '78f77025-74b7-4f26-9f7f-42ee84b9744c', '[218,229,101,23,995,197,636,691]', 'deterministic', '2026-09-29 21:19:08.98928+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e06b5dcf-dfa0-4051-922c-f17c74d72651', '[218,229,101,23,991,197,637,691]', 'deterministic', '2026-09-29 21:19:08.991338+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e2081c0b-cf18-4bbe-9a9c-44ef2a48dabe', '[218,229,101,23,992,197,638,691]', 'deterministic', '2026-09-29 21:19:08.993097+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e5b7d4de-20f6-49f9-9c9f-f8d7b52db74a', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-29 21:19:08.994894+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '496090f5-d621-4c95-ada9-f7013ab52acc', '[236,824,78,391,51,180,632,690]', 'deterministic', '2026-09-29 21:19:09.15983+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '6adbf50b-61e7-4b03-a54a-f9c4d2960d73', '[236,824,78,391,52,180,633,690]', 'deterministic', '2026-09-29 21:19:09.162477+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '2ea3bcd6-8d52-44b6-84ea-3e1c2d815346', '[236,824,78,391,53,180,634,690]', 'deterministic', '2026-09-29 21:19:09.164423+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '114fa41b-0db7-40c6-a5bf-f70e8d14ce0a', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-29 21:19:09.166371+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'e2768f28-5722-457e-aadf-7918c1f6af0e', '[236,824,78,391,55,180,636,690]', 'deterministic', '2026-09-29 21:19:09.168088+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'ec8f5a3c-0b36-4080-a8e4-bc7e3d15c5ea', '[236,824,78,391,51,180,637,690]', 'deterministic', '2026-09-29 21:19:09.169804+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '04049d67-9084-4e11-8721-2e6c76210229', '[236,824,78,391,52,180,638,690]', 'deterministic', '2026-09-29 21:19:09.171521+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '9f24e4e1-0c22-45c0-9f03-b834cf4a5275', '[236,824,78,391,53,180,639,690]', 'deterministic', '2026-09-29 21:19:09.173335+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'da9fe5f8-52b7-4d40-8de7-1513742246ec', '[236,824,78,391,54,180,640,690]', 'deterministic', '2026-09-29 21:19:09.175214+00');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'b16c41a7-e0dd-48bf-a5e9-17732265cfb4', '[236,824,78,391,55,180,641,690]', 'deterministic', '2026-09-29 21:19:09.176929+00');


--
-- Data for Name: memory_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_events VALUES ('06f0ce36-1627-4b34-a3cd-b8c5d5c7df09', 'tenant-a', 'e0081a9b-ab0b-4d2e-aace-2fb878388ee3', 'created', '2026-09-29 21:19:08.677+00', '{"type": "system"}', 'tenant-a の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8a8e162c-6163-4aed-8387-c23974b275bd"}');
INSERT INTO public.memory_events VALUES ('60a174aa-d281-442f-8cf6-f7420fdb422b', 'tenant-a', 'a46ec3f5-43bf-4d94-894f-8fb2de2de3f6', 'created', '2026-09-29 21:19:08.684+00', '{"type": "system"}', 'tenant-a の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b035ff62-7ee1-40af-b367-c8437519ce6d"}');
INSERT INTO public.memory_events VALUES ('689a350d-d866-4842-a4e6-0c8d1310cb65', 'tenant-a', '897a41c6-5c2d-4f4d-add6-3b099d95114b', 'created', '2026-09-29 21:19:08.691+00', '{"type": "system"}', 'tenant-a の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b0bbb193-6758-4e88-916e-f9457ab225c5"}');
INSERT INTO public.memory_events VALUES ('82c46958-3ce8-4b9d-94b0-2e6181913bbd', 'tenant-a', 'f470586c-8af7-4d6c-895d-3f2884d38869', 'created', '2026-09-29 21:19:08.696+00', '{"type": "system"}', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "15776850-3aac-4027-9217-0d46efc78442"}');
INSERT INTO public.memory_events VALUES ('cc353032-5701-4600-b5de-476279760d3a', 'tenant-a', '8ccbe3e6-666d-407c-8e9e-2bfc8e0d7247', 'created', '2026-09-29 21:19:08.701+00', '{"type": "system"}', 'tenant-a の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "abf7f084-e955-4de9-ba71-e2a6d2401a59"}');
INSERT INTO public.memory_events VALUES ('a1939b38-413c-417c-8756-0984047963fb', 'tenant-a', 'db0bc183-c53f-417c-b4c1-025cd7474242', 'created', '2026-09-29 21:19:08.705+00', '{"type": "system"}', 'tenant-a の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "706d4062-1d1c-42e9-ad6f-576e962fe852"}');
INSERT INTO public.memory_events VALUES ('ef57b657-7d30-46fe-8d97-550bb136fdf1', 'tenant-a', '149ba346-7bb5-4479-b380-01b7520b1518', 'created', '2026-09-29 21:19:08.708+00', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6438b316-cb4c-4262-bea5-71ff5b236d50"}');
INSERT INTO public.memory_events VALUES ('059e0f99-76fa-4784-9945-c4e3b5d1b6e9', 'tenant-a', '3a1709cc-8637-4bf5-8dee-39dada23cb30', 'created', '2026-09-29 21:19:08.712+00', '{"type": "system"}', 'tenant-a の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7f87ee73-f3de-4ecf-af32-de84ac094d6d"}');
INSERT INTO public.memory_events VALUES ('c4a639c1-d45a-41cc-955e-0283b4884c31', 'tenant-a', 'f74cbb10-2e47-42d6-a35c-10b63088ecd8', 'created', '2026-09-29 21:19:08.716+00', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c1ff49f0-2232-494e-a4eb-b7e28e7c46b1"}');
INSERT INTO public.memory_events VALUES ('522165dc-5c0b-45fc-8934-74b928d26f45', 'tenant-a', '8f215c06-e527-47ea-8294-c72de198b4ef', 'created', '2026-09-29 21:19:08.725+00', '{"type": "system"}', 'tenant-a の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9688e6e4-35a5-42e6-8a14-1b94e504f7b3"}');
INSERT INTO public.memory_events VALUES ('58303377-f0b4-4dd5-91d5-241b0ecbedfd', 'tenant-a', 'c5257309-a313-4edf-8710-5239d035fd2a', 'created', '2026-09-29 21:19:08.729+00', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "11e173f7-baf8-44b7-8475-484467f6ea3c"}');
INSERT INTO public.memory_events VALUES ('2e0534c1-1e05-4681-a782-3b3edd5d6de4', 'tenant-a', 'f1f4150b-0690-465b-9191-cdf95b34f776', 'created', '2026-09-29 21:19:08.733+00', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d9b2cd55-2d66-4e0a-a6ab-022d72dff4b1"}');
INSERT INTO public.memory_events VALUES ('361988a0-bb54-4f21-8ff1-904b44376029', 'tenant-a', '4ce790df-4e6f-4fe7-aa9e-aa9a89f03ca9', 'created', '2026-09-29 21:19:08.737+00', '{"type": "system"}', 'tenant-a の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c397cd2f-9a92-44c4-835f-5d2356437e9c"}');
INSERT INTO public.memory_events VALUES ('20a1bf2e-29f0-4beb-b225-28191c0d67d6', 'tenant-a', 'ee33db96-defd-4b3b-949b-77a1e65dab86', 'created', '2026-09-29 21:19:08.741+00', '{"type": "system"}', 'tenant-a の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "89b67872-9cf0-43c4-8995-9c0bec34a05c"}');
INSERT INTO public.memory_events VALUES ('a4e65e33-7832-49bb-b9ec-2c89857768e2', 'tenant-a', '77445d98-551f-4602-89ca-170a70a6a7d8', 'created', '2026-09-29 21:19:08.747+00', '{"type": "system"}', 'tenant-a の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ca4b8cd8-4a09-412c-988d-43f733fa9c1e"}');
INSERT INTO public.memory_events VALUES ('515f2f20-5e57-4a06-9b82-a4df3e21d183', 'tenant-a', '8616afb7-77f5-48ef-b83a-8fa785553645', 'created', '2026-09-29 21:19:08.751+00', '{"type": "system"}', 'tenant-a の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bee79136-a1c1-4665-9f61-0c65c07a7252"}');
INSERT INTO public.memory_events VALUES ('c6614122-9919-466c-8f72-f1d498f287b2', 'tenant-a', 'fd108a3f-04aa-49a3-ac6d-d59bac1508bc', 'created', '2026-09-29 21:19:08.755+00', '{"type": "system"}', 'tenant-a の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "13e496d2-9c05-4187-9753-f204298d1171"}');
INSERT INTO public.memory_events VALUES ('73f243f5-d595-4b25-91e7-06e5e6273cdc', 'tenant-a', '9a2bcf9e-4b48-49f9-84b6-30bd672a47da', 'created', '2026-09-29 21:19:08.759+00', '{"type": "system"}', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "07a628c9-16dd-476e-be91-70f344679082"}');
INSERT INTO public.memory_events VALUES ('f2284e0e-dcb2-4897-b14b-0c353d07e1d8', 'tenant-a', '18825385-0942-41ff-b004-0dad509b8bf4', 'created', '2026-09-29 21:19:08.762+00', '{"type": "system"}', 'tenant-a の記憶 18 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6532b6b6-32de-4e31-b849-fed93b5482c1"}');
INSERT INTO public.memory_events VALUES ('a3d21f47-a141-4ada-8a82-f8640d008634', 'tenant-a', '37614f7f-d6cb-44b6-a392-d1dba00ae236', 'created', '2026-09-29 21:19:08.766+00', '{"type": "system"}', 'tenant-a の記憶 19 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "47fcfc91-7cd0-4f0b-8b82-fed236f534c4"}');
INSERT INTO public.memory_events VALUES ('eaaa0cd7-e2f2-41c0-bc5e-763333946894', 'tenant-a', 'eceeb8ce-53c8-4f31-bd48-8a58beab0285', 'created', '2026-09-29 21:19:08.769+00', '{"type": "system"}', 'tenant-a の記憶 20 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8f97a6e0-4c17-4acb-b739-1e7ace4189ac"}');
INSERT INTO public.memory_events VALUES ('7804c3f4-8cc2-4ba5-9b12-552b69ec987e', 'tenant-a', '65826ca6-3ea1-409b-877a-cbeb6cc2178c', 'created', '2026-09-29 21:19:08.773+00', '{"type": "system"}', 'tenant-a の記憶 21 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "274e9155-126a-40f5-8cd7-68fb71bd732d"}');
INSERT INTO public.memory_events VALUES ('7ded545f-2d89-4e68-9e7b-d280deef1f37', 'tenant-a', 'b971cb6f-4f8f-489f-a92e-f4b5399a2b12', 'created', '2026-09-29 21:19:08.777+00', '{"type": "system"}', 'tenant-a の記憶 22 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c7b3a269-f35f-4d4d-a91c-bc3da1e1cd4d"}');
INSERT INTO public.memory_events VALUES ('7c9c4738-d91e-4378-aab7-e786bf608b72', 'tenant-a', '22328c13-90e3-44a3-994e-fa03fce4715c', 'created', '2026-09-29 21:19:08.781+00', '{"type": "system"}', 'tenant-a の記憶 23 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "baf68620-4987-489f-b538-a777dc0da466"}');
INSERT INTO public.memory_events VALUES ('6d3e316b-5d02-405d-8c93-cbacd3db9e1b', 'tenant-a', 'b1bdc4cb-d784-4f00-86b3-b8e4175b797d', 'created', '2026-09-29 21:19:08.785+00', '{"type": "system"}', 'tenant-a FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d7b1d29b-dfd3-4468-8d02-1ecb4dc41d2e"}');
INSERT INTO public.memory_events VALUES ('e7d566df-5ee1-4b37-8ece-83de1f9a31f5', 'tenant-a', '65da3405-5041-492f-af51-311727b215f9', 'created', '2026-09-29 21:19:08.845+00', '{"type": "system"}', 'tenant-a 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "906514f6-b0e3-4225-9915-04ef002a634f"}');
INSERT INTO public.memory_events VALUES ('a8c15669-9b36-4abc-9181-5528d2a50b90', 'tenant-a', 'c35c9683-2387-4754-8aa2-77f7f9e132bc', 'created', '2026-09-29 21:19:08.849+00', '{"type": "system"}', 'tenant-a 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "043a4fc9-f13d-41bf-b5a9-d45fcd88a8ed"}');
INSERT INTO public.memory_events VALUES ('15c59c1e-d242-4e14-828d-b9ca9a259f42', 'tenant-a', 'f5164112-4633-45d4-9b50-060b98958dd4', 'created', '2026-09-29 21:19:08.852+00', '{"type": "system"}', 'tenant-a 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "75ec33b6-7e89-4d5c-9c95-862af04e2e1c"}');
INSERT INTO public.memory_events VALUES ('bb996789-98cc-4d35-abb0-0cc170d2af6b', 'tenant-a', '149ba346-7bb5-4479-b380-01b7520b1518', 'updated', '2026-09-29 21:19:08.855+00', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "f74cbb10-2e47-42d6-a35c-10b63088ecd8"}');
INSERT INTO public.memory_events VALUES ('41647e4f-b60d-4cde-8ae2-14350d457b5e', 'tenant-a', 'f74cbb10-2e47-42d6-a35c-10b63088ecd8', 'updated', '2026-09-29 21:19:08.855+00', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "149ba346-7bb5-4479-b380-01b7520b1518"}');
INSERT INTO public.memory_events VALUES ('70254f4e-7feb-4c2c-967a-9dbb82682a65', 'tenant-a', 'c5257309-a313-4edf-8710-5239d035fd2a', 'forgotten', '2026-09-29 21:19:08.859+00', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('4950fb39-391d-4acf-94e6-36c0d801ef8f', 'tenant-a', 'f1f4150b-0690-465b-9191-cdf95b34f776', 'forgotten', '2026-09-29 21:19:08.86+00', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('8f54ac44-adb2-4db8-90f4-c8cdd6ba089b', 'tenant-a', 'f1f4150b-0690-465b-9191-cdf95b34f776', 'purged', '2026-09-29 21:19:08.862+00', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('f0637106-2fa6-49af-8aad-cea639757933', 'tenant-b', '34bc6c50-4daf-455e-93a8-c0810d9af8d2', 'created', '2026-09-29 21:19:08.893+00', '{"type": "system"}', 'tenant-b の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8efb7ec9-c77a-48e5-9262-2a0ca64d64e4"}');
INSERT INTO public.memory_events VALUES ('04616837-1257-4679-bcb5-c74992b5f2ce', 'tenant-b', 'b2b96f0e-a4b7-4073-9829-a62a14b5a6a8', 'created', '2026-09-29 21:19:08.897+00', '{"type": "system"}', 'tenant-b の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cd61fbcb-9f78-47c9-903c-1eb5cd9561a7"}');
INSERT INTO public.memory_events VALUES ('28febf5a-5e78-49ea-b33b-c5e088b7cb5c', 'tenant-b', '8ee354d2-7ac4-4c57-9d74-e58d0b8c0a58', 'created', '2026-09-29 21:19:08.901+00', '{"type": "system"}', 'tenant-b の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "531dac99-af73-4f54-ba8a-27372bb1dd68"}');
INSERT INTO public.memory_events VALUES ('10d303d4-98d7-44c8-9582-8f1185af5d53', 'tenant-b', '40156ace-7cd4-4039-acf9-329df0ab0023', 'created', '2026-09-29 21:19:08.904+00', '{"type": "system"}', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e3c68bda-385c-4e10-b81f-698cea62de03"}');
INSERT INTO public.memory_events VALUES ('f90a061a-8254-4748-9df8-dda90c3eeeec', 'tenant-b', 'b8aed883-24b6-4e41-b086-5fdfc3f0c661', 'created', '2026-09-29 21:19:08.908+00', '{"type": "system"}', 'tenant-b の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "75674ce3-6231-4247-a551-527d9494337f"}');
INSERT INTO public.memory_events VALUES ('bdf131b9-04db-4bdf-bd47-9eeead0a1c9e', 'tenant-b', '006a5c23-3369-4987-a892-6ba3458bbc0f', 'created', '2026-09-29 21:19:08.912+00', '{"type": "system"}', 'tenant-b の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e2c90494-a1bd-43e8-9d7a-69126471ce3d"}');
INSERT INTO public.memory_events VALUES ('6e5f08a6-4895-4e08-9953-dde7f8b5218b', 'tenant-b', '06e363fc-41f9-423b-84cf-57c3948d536f', 'created', '2026-09-29 21:19:08.915+00', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "43893183-ea94-4fa3-a2d3-a3931f62800b"}');
INSERT INTO public.memory_events VALUES ('15e57403-2385-45d6-bf4f-55fa6878bc5a', 'tenant-b', '914f6a5a-33b7-4a76-99bc-822d89a29b7e', 'created', '2026-09-29 21:19:08.919+00', '{"type": "system"}', 'tenant-b の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "51e383ab-8e8b-4306-9db1-6bddee6393de"}');
INSERT INTO public.memory_events VALUES ('f7809e4d-a66f-4998-bd21-1c0428a27183', 'tenant-b', '1ecb2047-167b-45a7-af37-7559bd95ece3', 'created', '2026-09-29 21:19:08.923+00', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f3cf3f85-9c47-4e80-b705-933d585658f9"}');
INSERT INTO public.memory_events VALUES ('cd86486a-15f6-4693-bda9-cb1e9085c56d', 'tenant-b', 'd1c301c6-60d9-48f1-bf66-ab932c3a9f26', 'created', '2026-09-29 21:19:08.927+00', '{"type": "system"}', 'tenant-b の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7c07ab26-9013-43f2-a0b8-0d3575981279"}');
INSERT INTO public.memory_events VALUES ('f52a42d1-85b7-45c0-b612-6ec63cba9478', 'tenant-b', '95212a43-882e-4e2c-ac32-b18f7877d654', 'created', '2026-09-29 21:19:08.931+00', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "56839a6d-76ec-41c8-9b00-60c5d15c535f"}');
INSERT INTO public.memory_events VALUES ('d05ad7fa-9aab-4076-987b-73757251e112', 'tenant-b', '43ae5893-9b66-4023-aac5-500a87b70b05', 'created', '2026-09-29 21:19:08.934+00', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8a6b99cc-bb57-48f2-ba45-892febca79a2"}');
INSERT INTO public.memory_events VALUES ('a9e4f585-ad65-433d-9e29-ac07fe468c86', 'tenant-b', 'b653da21-8dd6-4080-82dc-793dab1a8c15', 'created', '2026-09-29 21:19:08.938+00', '{"type": "system"}', 'tenant-b の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "48578e71-dbce-42b5-ba25-34fb24e113ef"}');
INSERT INTO public.memory_events VALUES ('04b90532-85c9-4e9b-a79b-bae3ad1d8cc9', 'tenant-b', '88672c65-0318-46aa-9979-efb590afe38a', 'created', '2026-09-29 21:19:08.942+00', '{"type": "system"}', 'tenant-b の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "fb54fe23-f81b-444f-80a8-69bfed6d310f"}');
INSERT INTO public.memory_events VALUES ('308d1dae-9e85-49dd-8ae0-5a7f548aeac9', 'tenant-b', '78f77025-74b7-4f26-9f7f-42ee84b9744c', 'created', '2026-09-29 21:19:08.945+00', '{"type": "system"}', 'tenant-b の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "401a6b2a-e77e-452d-9180-b6cc1e6e793a"}');
INSERT INTO public.memory_events VALUES ('7300e953-3cfd-42a2-af66-6ce55d53f373', 'tenant-b', 'e06b5dcf-dfa0-4051-922c-f17c74d72651', 'created', '2026-09-29 21:19:08.949+00', '{"type": "system"}', 'tenant-b の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4786d953-f28f-4973-bce3-5ba5173214f0"}');
INSERT INTO public.memory_events VALUES ('51ca86f7-9d11-4335-b857-9ade49161c24', 'tenant-b', 'e2081c0b-cf18-4bbe-9a9c-44ef2a48dabe', 'created', '2026-09-29 21:19:08.952+00', '{"type": "system"}', 'tenant-b の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f665cf43-f902-4eef-a8df-63b6e7439b8a"}');
INSERT INTO public.memory_events VALUES ('b595b256-abf6-4080-ad98-daff37481ae9', 'tenant-b', 'e5b7d4de-20f6-49f9-9c9f-f8d7b52db74a', 'created', '2026-09-29 21:19:08.955+00', '{"type": "system"}', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f31c9fef-4429-4f70-ab3b-58b430ee8f79"}');
INSERT INTO public.memory_events VALUES ('6977b109-b5bb-4175-8c26-187e0c1b5f75', 'tenant-b', 'a557b10f-571d-481a-ab40-f77579405ccc', 'created', '2026-09-29 21:19:08.959+00', '{"type": "system"}', 'tenant-b FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e37b2220-cd40-4c73-abb9-d41c35d034b1"}');
INSERT INTO public.memory_events VALUES ('3be4a7dd-bcb8-4834-9d19-a7cbd1345132', 'tenant-b', '370a2fd7-0122-4f2c-8067-33b2105b749d', 'created', '2026-09-29 21:19:09.001+00', '{"type": "system"}', 'tenant-b 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "43a023e0-7cc6-4ea2-be6e-5574676665b2"}');
INSERT INTO public.memory_events VALUES ('eccdddae-476c-4470-b976-e49663265558', 'tenant-b', 'c671fe01-0eb3-4ec6-a4d3-139226e4f756', 'created', '2026-09-29 21:19:09.005+00', '{"type": "system"}', 'tenant-b 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "bfdd12a5-6077-42ad-a650-d14d2a410282"}');
INSERT INTO public.memory_events VALUES ('26d5b14c-93ce-47fa-a1c3-412fd11500b1', 'tenant-b', 'a6369cc6-0d23-4855-b2b2-9c17bb601ac4', 'created', '2026-09-29 21:19:09.008+00', '{"type": "system"}', 'tenant-b 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6d3cc096-b9de-480c-91e2-4b5ac3fcdf83"}');
INSERT INTO public.memory_events VALUES ('14b77f54-ce05-4870-ad3d-37ad23987721', 'tenant-b', '06e363fc-41f9-423b-84cf-57c3948d536f', 'updated', '2026-09-29 21:19:09.01+00', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "1ecb2047-167b-45a7-af37-7559bd95ece3"}');
INSERT INTO public.memory_events VALUES ('19eeda8f-7864-445e-80cf-7b775402c320', 'tenant-b', '1ecb2047-167b-45a7-af37-7559bd95ece3', 'updated', '2026-09-29 21:19:09.01+00', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "06e363fc-41f9-423b-84cf-57c3948d536f"}');
INSERT INTO public.memory_events VALUES ('cd1a5c34-1c95-41bb-bde6-40d6b3af5ae7', 'tenant-b', '95212a43-882e-4e2c-ac32-b18f7877d654', 'forgotten', '2026-09-29 21:19:09.013+00', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('3bba3260-bc74-455b-84d0-842ef424a5d4', 'tenant-b', '43ae5893-9b66-4023-aac5-500a87b70b05', 'forgotten', '2026-09-29 21:19:09.014+00', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('2764c4ef-940a-4c59-b833-207475d14477', 'tenant-b', '43ae5893-9b66-4023-aac5-500a87b70b05', 'purged', '2026-09-29 21:19:09.015+00', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('55850ff3-88ee-4d14-8a67-6c1edd3e68ef', 'tenant-b', '1ecb2047-167b-45a7-af37-7559bd95ece3', 'forgotten', '2026-09-29 21:19:09.02+00', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "fixture: orphaned contested"}');
INSERT INTO public.memory_events VALUES ('aa39341d-7222-4b6b-a664-88afdaafd678', 'tenant-c', '803c4e49-e08f-40ff-bf33-1677351cdde8', 'created', '2026-09-29 21:19:09.034+00', '{"type": "system"}', 'tenant-c の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0facdd38-35cc-4543-965d-ae3ae08040fa"}');
INSERT INTO public.memory_events VALUES ('54834fa9-f908-4376-8456-000ea6cbedae', 'tenant-c', 'ad31ac07-561f-4ab2-9ac4-f4af9f071447', 'created', '2026-09-29 21:19:09.037+00', '{"type": "system"}', 'tenant-c の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "644d968f-6494-46ea-8a12-ff4e074ffe92"}');
INSERT INTO public.memory_events VALUES ('fa1c4e31-079f-499f-bf73-484e880af14e', 'tenant-c', '0896592a-b088-4259-b675-f294ec3f24ae', 'created', '2026-09-29 21:19:09.04+00', '{"type": "system"}', 'tenant-c の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9bcb410b-077c-43da-b04d-e58368dc38aa"}');
INSERT INTO public.memory_events VALUES ('245338d7-c744-4c84-8482-de3deb566b8b', 'tenant-c', '529fec4e-b51e-4354-81f5-915f551fc090', 'created', '2026-09-29 21:19:09.043+00', '{"type": "system"}', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9196f304-ce8b-4c1c-ac89-c6b43c024e4e"}');
INSERT INTO public.memory_events VALUES ('aee58eae-e9ac-4a5a-a4d5-aabb33a71bd4', 'tenant-c', '6c7d210c-ea61-4443-97d8-7678c838e050', 'created', '2026-09-29 21:19:09.046+00', '{"type": "system"}', 'tenant-c の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0c94269a-8cad-4080-8b0f-575cc0d63c8a"}');
INSERT INTO public.memory_events VALUES ('9037e143-3811-46ca-ada2-ae868bd80668', 'tenant-c', '80b4062f-7499-4a58-b4eb-754ec4780413', 'created', '2026-09-29 21:19:09.049+00', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "610153bf-c054-4e78-8fb5-7d3e951402b5"}');
INSERT INTO public.memory_events VALUES ('b549759f-3864-4c05-a89b-d31330fb9e07', 'tenant-c', 'e1269471-f54e-4110-888a-efba39fde35a', 'created', '2026-09-29 21:19:09.052+00', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "756cd911-410b-449b-b958-134c6e625b2c"}');
INSERT INTO public.memory_events VALUES ('bb80ddce-fdf0-4e81-befc-6191446ec120', 'tenant-c', '50208925-5184-435d-a475-8e89257cbc8c', 'created', '2026-09-29 21:19:09.056+00', '{"type": "system"}', 'tenant-c の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "09766e6d-407a-4bae-a3e9-6d6babf94119"}');
INSERT INTO public.memory_events VALUES ('7b471171-8731-44de-8224-bcd07419bac4', 'tenant-c', '5087e2e0-e935-4722-9c97-ea12083cc089', 'created', '2026-09-29 21:19:09.059+00', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d5ddf8d1-4f81-49f3-bac9-852956fb3693"}');
INSERT INTO public.memory_events VALUES ('89832ea9-3828-4a51-8cbe-9db0a11b813e', 'tenant-c', '9116da75-f860-4d17-89a4-2f64e54d8ce6', 'created', '2026-09-29 21:19:09.062+00', '{"type": "system"}', 'tenant-c の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "749cde64-66b2-4a6d-ad6a-bd4fefcca044"}');
INSERT INTO public.memory_events VALUES ('e0461533-3393-459a-9f0e-d47f3b01b889', 'tenant-c', '2d300c70-9a57-4349-a006-717b3abfc57c', 'created', '2026-09-29 21:19:09.065+00', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e2263584-7278-4538-bb60-e6adb182d2b4"}');
INSERT INTO public.memory_events VALUES ('9b2bda4a-8b83-466b-b875-913495cc548f', 'tenant-c', 'd76c3b7e-2b3c-49b3-8be7-303230c6584a', 'created', '2026-09-29 21:19:09.068+00', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4e969f2f-f3cf-4725-bf0f-6652e6b6bbb7"}');
INSERT INTO public.memory_events VALUES ('86f418a5-bb01-4165-83e4-def6931a7375', 'tenant-c', '1a9e0273-c36f-45ed-89eb-4106208cd32d', 'created', '2026-09-29 21:19:09.071+00', '{"type": "system"}', 'tenant-c FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7688f2bb-c599-4ffd-9781-2ef918cce1d1"}');
INSERT INTO public.memory_events VALUES ('cc8da6f5-1205-4acd-ae80-e8682434e310', 'tenant-c', '6023da71-4646-4143-8d63-6021c08c06b7', 'created', '2026-09-29 21:19:09.098+00', '{"type": "system"}', 'tenant-c 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ac3a6801-99b0-43fc-acba-3b2fd5dedf2e"}');
INSERT INTO public.memory_events VALUES ('842869fd-a31c-4df6-99bc-3a337ecb56e0', 'tenant-c', '03c2f3f3-f14c-4b43-8b71-ea306b03de60', 'created', '2026-09-29 21:19:09.101+00', '{"type": "system"}', 'tenant-c 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "57f33b89-4937-47dc-ab90-21ad5840cbb9"}');
INSERT INTO public.memory_events VALUES ('cfa89ed9-91c8-4e4d-a173-014fc33cb034', 'tenant-c', '423c076d-ec57-4c09-baa3-f598d7b15a75', 'created', '2026-09-29 21:19:09.104+00', '{"type": "system"}', 'tenant-c 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "10c5dbda-ab9f-473c-ba76-337787c1c29e"}');
INSERT INTO public.memory_events VALUES ('f7be7eb0-10e4-45be-9bba-0ef30e4bf158', 'tenant-c', 'e1269471-f54e-4110-888a-efba39fde35a', 'updated', '2026-09-29 21:19:09.106+00', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "5087e2e0-e935-4722-9c97-ea12083cc089"}');
INSERT INTO public.memory_events VALUES ('ce2b2e35-0878-4afa-9bd6-22d2469c9c99', 'tenant-c', '5087e2e0-e935-4722-9c97-ea12083cc089', 'updated', '2026-09-29 21:19:09.106+00', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "e1269471-f54e-4110-888a-efba39fde35a"}');
INSERT INTO public.memory_events VALUES ('029f28a9-a3e9-4672-96f5-ad7c2bbdd570', 'tenant-c', '2d300c70-9a57-4349-a006-717b3abfc57c', 'forgotten', '2026-09-29 21:19:09.109+00', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('230a39e6-eb0f-4192-b543-0c9d2a617e27', 'tenant-c', 'd76c3b7e-2b3c-49b3-8be7-303230c6584a', 'forgotten', '2026-09-29 21:19:09.11+00', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('27e4989b-fa1e-4c3a-9018-c5682d443b2a', 'tenant-c', 'd76c3b7e-2b3c-49b3-8be7-303230c6584a', 'purged', '2026-09-29 21:19:09.111+00', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('c236d17c-5c50-4c9b-b20c-7a9044b74f51', 'tenant-c', '80b4062f-7499-4a58-b4eb-754ec4780413', 'forgotten', '2026-09-29 21:19:09.115+00', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "fixture: successor forgotten"}');
INSERT INTO public.memory_events VALUES ('e88fec22-b8d8-4ef1-b5e9-440f47a75c78', 'tenant-a2', '496090f5-d621-4c95-ada9-f7013ab52acc', 'created', '2026-09-29 21:19:09.128+00', '{"type": "system"}', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "22d87971-b16d-40cd-9c9d-ef9b1220512d"}');
INSERT INTO public.memory_events VALUES ('e6158532-96be-4b65-bfd5-d4323ec4c7ae', 'tenant-a2', '6adbf50b-61e7-4b03-a54a-f9c4d2960d73', 'created', '2026-09-29 21:19:09.131+00', '{"type": "system"}', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "be096dd0-5a06-465f-ab87-0ea845b68130"}');
INSERT INTO public.memory_events VALUES ('79f0f3a0-5784-4052-80b0-baadd3608614', 'tenant-a2', '2ea3bcd6-8d52-44b6-84ea-3e1c2d815346', 'created', '2026-09-29 21:19:09.134+00', '{"type": "system"}', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "538f5b86-ad57-4764-b18d-78c1d876697a"}');
INSERT INTO public.memory_events VALUES ('fb747de7-537a-4ba7-9a6c-2b93ee6606c1', 'tenant-a2', '114fa41b-0db7-40c6-a5bf-f70e8d14ce0a', 'created', '2026-09-29 21:19:09.138+00', '{"type": "system"}', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "288ae0e3-74ca-4be1-bd12-c20ade29adc9"}');
INSERT INTO public.memory_events VALUES ('c37166d5-a51f-4500-9bb5-861106ab379d', 'tenant-a2', 'e2768f28-5722-457e-aadf-7918c1f6af0e', 'created', '2026-09-29 21:19:09.141+00', '{"type": "system"}', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d6393d8b-3482-4669-860b-59b9cc83e922"}');
INSERT INTO public.memory_events VALUES ('ddc2d792-1e6c-4c19-81f9-1fc9b20d14b3', 'tenant-a2', 'ec8f5a3c-0b36-4080-a8e4-bc7e3d15c5ea', 'created', '2026-09-29 21:19:09.144+00', '{"type": "system"}', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0dd58802-84bf-4811-a64c-b7be9adeb8c5"}');
INSERT INTO public.memory_events VALUES ('55972266-f975-479d-ad63-2bc0e8b63b6c', 'tenant-a2', '04049d67-9084-4e11-8721-2e6c76210229', 'created', '2026-09-29 21:19:09.147+00', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "632f2625-a6f9-4ffe-b9d8-4c01e6ad96c4"}');
INSERT INTO public.memory_events VALUES ('05217f8e-319c-4f29-954d-942df6e7bd4b', 'tenant-a2', '9f24e4e1-0c22-45c0-9f03-b834cf4a5275', 'created', '2026-09-29 21:19:09.15+00', '{"type": "system"}', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "10880072-5972-4e26-9fd7-e27e3dfdd759"}');
INSERT INTO public.memory_events VALUES ('c4618679-de2d-488e-aeec-c7ccbfb6a8e1', 'tenant-a2', 'da9fe5f8-52b7-4d40-8de7-1513742246ec', 'created', '2026-09-29 21:19:09.153+00', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "16fc8e75-9ee5-43bd-9dd3-e75595f71ae6"}');
INSERT INTO public.memory_events VALUES ('89b9246d-33a3-4395-8b8a-61815d50a533', 'tenant-a2', 'b16c41a7-e0dd-48bf-a5e9-17732265cfb4', 'created', '2026-09-29 21:19:09.156+00', '{"type": "system"}', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9c25633b-0a84-40ba-8113-43263ffa210f"}');
INSERT INTO public.memory_events VALUES ('4d866739-7338-447a-9ab2-f228c2973431', 'tenant-a2', 'b4ef02b5-0add-4954-a753-17beef9a4947', 'created', '2026-09-29 21:19:09.159+00', '{"type": "system"}', 'tenant-a2 FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c60394fd-2f6c-4c4f-b73c-3171617dbab8"}');
INSERT INTO public.memory_events VALUES ('d9535d03-3c16-408b-b3c5-a96f94330852', 'tenant-a2', 'adf5081f-804e-4f4f-ae6f-19de33396c47', 'created', '2026-09-29 21:19:09.182+00', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "32cb7fd4-9db9-4344-ad1e-b812e31b4487"}');
INSERT INTO public.memory_events VALUES ('592ab7a3-2cec-4cbb-9e92-6243729ef4b9', 'tenant-a2', 'f1027e42-06bb-4ba2-82bf-d4949f56d5e9', 'created', '2026-09-29 21:19:09.186+00', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b015484f-449f-4a8c-a3ca-1c2f8f76ee21"}');
INSERT INTO public.memory_events VALUES ('96d574b2-046b-48f0-9118-813a835a9a68', 'tenant-a2', '47251278-3368-477b-b190-caefb117fe06', 'created', '2026-09-29 21:19:09.189+00', '{"type": "system"}', 'tenant-a2 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9deda963-7bce-4907-bb6f-80c07a63a2b6"}');
INSERT INTO public.memory_events VALUES ('60081756-97b1-40d6-ba9f-2b73d432a123', 'tenant-a2', '04049d67-9084-4e11-8721-2e6c76210229', 'updated', '2026-09-29 21:19:09.191+00', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "da9fe5f8-52b7-4d40-8de7-1513742246ec"}');
INSERT INTO public.memory_events VALUES ('4b8405b5-7ad1-46ed-9e6f-b5e561b51c92', 'tenant-a2', 'da9fe5f8-52b7-4d40-8de7-1513742246ec', 'updated', '2026-09-29 21:19:09.191+00', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "04049d67-9084-4e11-8721-2e6c76210229"}');
INSERT INTO public.memory_events VALUES ('aae0ba62-566a-4f41-9ce2-e04895047b86', 'tenant-a2', 'adf5081f-804e-4f4f-ae6f-19de33396c47', 'forgotten', '2026-09-29 21:19:09.194+00', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('ee4fcd15-bb47-4456-8abc-27e6ddeb1d11', 'tenant-a2', 'f1027e42-06bb-4ba2-82bf-d4949f56d5e9', 'forgotten', '2026-09-29 21:19:09.195+00', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('b2c64ae3-bdd3-43aa-993d-4d3d1348a665', 'tenant-a2', 'f1027e42-06bb-4ba2-82bf-d4949f56d5e9', 'purged', '2026-09-29 21:19:09.196+00', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');


--
-- Data for Name: memory_labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: observations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.observations VALUES ('8a8e162c-6163-4aed-8387-c23974b275bd', 'tenant-a', NULL, 'tenant-a-ext-0', 'utterance', '{"text": "tenant-a の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.668+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b035ff62-7ee1-40af-b367-c8437519ce6d', 'tenant-a', NULL, 'tenant-a-ext-1', 'utterance', '{"text": "tenant-a の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.679+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b0bbb193-6758-4e88-916e-f9457ab225c5', 'tenant-a', NULL, 'tenant-a-ext-2', 'utterance', '{"text": "tenant-a の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.686+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('15776850-3aac-4027-9217-0d46efc78442', 'tenant-a', NULL, 'tenant-a-ext-3', 'utterance', '{"text": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:08.693+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('abf7f084-e955-4de9-ba71-e2a6d2401a59', 'tenant-a', NULL, 'tenant-a-ext-4', 'utterance', '{"text": "tenant-a の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:08.697+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('706d4062-1d1c-42e9-ad6f-576e962fe852', 'tenant-a', NULL, 'tenant-a-ext-5', 'utterance', '{"text": "tenant-a の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.701+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6438b316-cb4c-4262-bea5-71ff5b236d50', 'tenant-a', NULL, 'tenant-a-ext-6', 'utterance', '{"text": "tenant-a の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.705+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7f87ee73-f3de-4ecf-af32-de84ac094d6d', 'tenant-a', NULL, 'tenant-a-ext-7', 'utterance', '{"text": "tenant-a の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.709+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c1ff49f0-2232-494e-a4eb-b7e28e7c46b1', 'tenant-a', NULL, 'tenant-a-ext-8', 'utterance', '{"text": "tenant-a の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:08.713+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9688e6e4-35a5-42e6-8a14-1b94e504f7b3', 'tenant-a', NULL, 'tenant-a-ext-9', 'utterance', '{"text": "tenant-a の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:08.721+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('11e173f7-baf8-44b7-8475-484467f6ea3c', 'tenant-a', NULL, 'tenant-a-ext-10', 'utterance', '{"text": "tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:08.726+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d9b2cd55-2d66-4e0a-a6ab-022d72dff4b1', 'tenant-a', NULL, 'tenant-a-ext-11', 'utterance', '{"text": "tenant-a の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.73+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c397cd2f-9a92-44c4-835f-5d2356437e9c', 'tenant-a', NULL, 'tenant-a-ext-12', 'utterance', '{"text": "tenant-a の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.734+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('89b67872-9cf0-43c4-8995-9c0bec34a05c', 'tenant-a', NULL, 'tenant-a-ext-13', 'utterance', '{"text": "tenant-a の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:08.738+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ca4b8cd8-4a09-412c-988d-43f733fa9c1e', 'tenant-a', NULL, 'tenant-a-ext-14', 'utterance', '{"text": "tenant-a の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:08.743+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bee79136-a1c1-4665-9f61-0c65c07a7252', 'tenant-a', NULL, 'tenant-a-ext-15', 'utterance', '{"text": "tenant-a の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.748+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('13e496d2-9c05-4187-9753-f204298d1171', 'tenant-a', NULL, 'tenant-a-ext-16', 'utterance', '{"text": "tenant-a の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.752+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('07a628c9-16dd-476e-be91-70f344679082', 'tenant-a', NULL, 'tenant-a-ext-17', 'utterance', '{"text": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:08.756+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6532b6b6-32de-4e31-b849-fed93b5482c1', 'tenant-a', NULL, 'tenant-a-ext-18', 'utterance', '{"text": "tenant-a の記憶 18 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:08.759+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('47fcfc91-7cd0-4f0b-8b82-fed236f534c4', 'tenant-a', NULL, 'tenant-a-ext-19', 'utterance', '{"text": "tenant-a の記憶 19 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:08.763+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8f97a6e0-4c17-4acb-b739-1e7ace4189ac', 'tenant-a', NULL, 'tenant-a-ext-20', 'utterance', '{"text": "tenant-a の記憶 20 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.767+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('274e9155-126a-40f5-8cd7-68fb71bd732d', 'tenant-a', NULL, 'tenant-a-ext-21', 'utterance', '{"text": "tenant-a の記憶 21 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.77+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c7b3a269-f35f-4d4d-a91c-bc3da1e1cd4d', 'tenant-a', NULL, 'tenant-a-ext-22', 'utterance', '{"text": "tenant-a の記憶 22 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.774+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('baf68620-4987-489f-b538-a777dc0da466', 'tenant-a', NULL, 'tenant-a-ext-23', 'utterance', '{"text": "tenant-a の記憶 23 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:08.777+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d7b1d29b-dfd3-4468-8d02-1ecb4dc41d2e', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-29 21:19:08.781+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('906514f6-b0e3-4225-9915-04ef002a634f', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.842+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('043a4fc9-f13d-41bf-b5a9-d45fcd88a8ed', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.846+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('75ec33b6-7e89-4d5c-9c95-862af04e2e1c', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.849+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ce7308b5-a4fb-40a8-87aa-13e7c6009fbb', 'tenant-a', NULL, NULL, 'usage', '{"recallId": "a0e91c1a-1c9e-49ed-9b5f-932d3d40ae54", "usedMemoryIds": ["eceeb8ce-53c8-4f31-bd48-8a58beab0285"]}', NULL, '2026-09-29 21:19:08.885+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8efb7ec9-c77a-48e5-9262-2a0ca64d64e4', 'tenant-b', NULL, 'tenant-b-ext-0', 'utterance', '{"text": "tenant-b の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.89+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('cd61fbcb-9f78-47c9-903c-1eb5cd9561a7', 'tenant-b', NULL, 'tenant-b-ext-1', 'utterance', '{"text": "tenant-b の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.894+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('531dac99-af73-4f54-ba8a-27372bb1dd68', 'tenant-b', NULL, 'tenant-b-ext-2', 'utterance', '{"text": "tenant-b の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.898+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e3c68bda-385c-4e10-b81f-698cea62de03', 'tenant-b', NULL, 'tenant-b-ext-3', 'utterance', '{"text": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:08.901+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('75674ce3-6231-4247-a551-527d9494337f', 'tenant-b', NULL, 'tenant-b-ext-4', 'utterance', '{"text": "tenant-b の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:08.905+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e2c90494-a1bd-43e8-9d7a-69126471ce3d', 'tenant-b', NULL, 'tenant-b-ext-5', 'utterance', '{"text": "tenant-b の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.909+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('43893183-ea94-4fa3-a2d3-a3931f62800b', 'tenant-b', NULL, 'tenant-b-ext-6', 'utterance', '{"text": "tenant-b の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.912+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('51e383ab-8e8b-4306-9db1-6bddee6393de', 'tenant-b', NULL, 'tenant-b-ext-7', 'utterance', '{"text": "tenant-b の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.916+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f3cf3f85-9c47-4e80-b705-933d585658f9', 'tenant-b', NULL, 'tenant-b-ext-8', 'utterance', '{"text": "tenant-b の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:08.92+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7c07ab26-9013-43f2-a0b8-0d3575981279', 'tenant-b', NULL, 'tenant-b-ext-9', 'utterance', '{"text": "tenant-b の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:08.924+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('56839a6d-76ec-41c8-9b00-60c5d15c535f', 'tenant-b', NULL, 'tenant-b-ext-10', 'utterance', '{"text": "tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:08.928+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8a6b99cc-bb57-48f2-ba45-892febca79a2', 'tenant-b', NULL, 'tenant-b-ext-11', 'utterance', '{"text": "tenant-b の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.931+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('48578e71-dbce-42b5-ba25-34fb24e113ef', 'tenant-b', NULL, 'tenant-b-ext-12', 'utterance', '{"text": "tenant-b の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:08.935+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('fb54fe23-f81b-444f-80a8-69bfed6d310f', 'tenant-b', NULL, 'tenant-b-ext-13', 'utterance', '{"text": "tenant-b の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:08.938+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('401a6b2a-e77e-452d-9180-b6cc1e6e793a', 'tenant-b', NULL, 'tenant-b-ext-14', 'utterance', '{"text": "tenant-b の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:08.942+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4786d953-f28f-4973-bce3-5ba5173214f0', 'tenant-b', NULL, 'tenant-b-ext-15', 'utterance', '{"text": "tenant-b の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.946+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f665cf43-f902-4eef-a8df-63b6e7439b8a', 'tenant-b', NULL, 'tenant-b-ext-16', 'utterance', '{"text": "tenant-b の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:08.95+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('f31c9fef-4429-4f70-ab3b-58b430ee8f79', 'tenant-b', NULL, 'tenant-b-ext-17', 'utterance', '{"text": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:08.953+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e37b2220-cd40-4c73-abb9-d41c35d034b1', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-29 21:19:08.956+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('43a023e0-7cc6-4ea2-be6e-5574676665b2', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-29 21:19:08.998+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('bfdd12a5-6077-42ad-a650-d14d2a410282', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.002+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6d3cc096-b9de-480c-91e2-4b5ac3fcdf83', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-29 21:19:09.005+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2fd08116-b1e0-4cce-bb6e-81a7f2a4db67', 'tenant-b', NULL, NULL, 'usage', '{"recallId": "d1164ed2-fc34-4b7c-8b8b-aaf0399adc65", "usedMemoryIds": ["78f77025-74b7-4f26-9f7f-42ee84b9744c"]}', NULL, '2026-09-29 21:19:09.028+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0facdd38-35cc-4543-965d-ae3ae08040fa', 'tenant-c', NULL, 'tenant-c-ext-0', 'utterance', '{"text": "tenant-c の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:09.031+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('644d968f-6494-46ea-8a12-ff4e074ffe92', 'tenant-c', NULL, 'tenant-c-ext-1', 'utterance', '{"text": "tenant-c の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.034+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9bcb410b-077c-43da-b04d-e58368dc38aa', 'tenant-c', NULL, 'tenant-c-ext-2', 'utterance', '{"text": "tenant-c の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:09.037+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9196f304-ce8b-4c1c-ac89-c6b43c024e4e', 'tenant-c', NULL, 'tenant-c-ext-3', 'utterance', '{"text": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:09.041+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0c94269a-8cad-4080-8b0f-575cc0d63c8a', 'tenant-c', NULL, 'tenant-c-ext-4', 'utterance', '{"text": "tenant-c の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:09.044+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('610153bf-c054-4e78-8fb5-7d3e951402b5', 'tenant-c', NULL, 'tenant-c-ext-5', 'utterance', '{"text": "tenant-c の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:09.047+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('756cd911-410b-449b-b958-134c6e625b2c', 'tenant-c', NULL, 'tenant-c-ext-6', 'utterance', '{"text": "tenant-c の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.05+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('09766e6d-407a-4bae-a3e9-6d6babf94119', 'tenant-c', NULL, 'tenant-c-ext-7', 'utterance', '{"text": "tenant-c の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:09.053+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d5ddf8d1-4f81-49f3-bac9-852956fb3693', 'tenant-c', NULL, 'tenant-c-ext-8', 'utterance', '{"text": "tenant-c の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:09.056+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('749cde64-66b2-4a6d-ad6a-bd4fefcca044', 'tenant-c', NULL, 'tenant-c-ext-9', 'utterance', '{"text": "tenant-c の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:09.059+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e2263584-7278-4538-bb60-e6adb182d2b4', 'tenant-c', NULL, 'tenant-c-ext-10', 'utterance', '{"text": "tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:09.062+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4e969f2f-f3cf-4725-bf0f-6652e6b6bbb7', 'tenant-c', NULL, 'tenant-c-ext-11', 'utterance', '{"text": "tenant-c の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.065+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7688f2bb-c599-4ffd-9781-2ef918cce1d1', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-29 21:19:09.069+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ac3a6801-99b0-43fc-acba-3b2fd5dedf2e', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-29 21:19:09.095+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('57f33b89-4937-47dc-ab90-21ad5840cbb9', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.099+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('10c5dbda-ab9f-473c-ba76-337787c1c29e', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-29 21:19:09.102+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e437dbe4-b8ae-47dc-8fde-994777671b21', 'tenant-c', NULL, NULL, 'usage', '{"recallId": "9f64d305-fd2a-4ff0-8e75-196b21b58228", "usedMemoryIds": ["0896592a-b088-4259-b675-f294ec3f24ae"]}', NULL, '2026-09-29 21:19:09.123+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('22d87971-b16d-40cd-9c9d-ef9b1220512d', 'tenant-a2', NULL, 'tenant-a2-ext-0', 'utterance', '{"text": "tenant-a2 の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:09.126+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('be096dd0-5a06-465f-ab87-0ea845b68130', 'tenant-a2', NULL, 'tenant-a2-ext-1', 'utterance', '{"text": "tenant-a2 の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.129+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('538f5b86-ad57-4764-b18d-78c1d876697a', 'tenant-a2', NULL, 'tenant-a2-ext-2', 'utterance', '{"text": "tenant-a2 の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:09.132+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('288ae0e3-74ca-4be1-bd12-c20ade29adc9', 'tenant-a2', NULL, 'tenant-a2-ext-3', 'utterance', '{"text": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-29 21:19:09.135+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d6393d8b-3482-4669-860b-59b9cc83e922', 'tenant-a2', NULL, 'tenant-a2-ext-4', 'utterance', '{"text": "tenant-a2 の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:09.138+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0dd58802-84bf-4811-a64c-b7be9adeb8c5', 'tenant-a2', NULL, 'tenant-a2-ext-5', 'utterance', '{"text": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-29 21:19:09.141+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('632f2625-a6f9-4ffe-b9d8-4c01e6ad96c4', 'tenant-a2', NULL, 'tenant-a2-ext-6', 'utterance', '{"text": "tenant-a2 の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.144+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('10880072-5972-4e26-9fd7-e27e3dfdd759', 'tenant-a2', NULL, 'tenant-a2-ext-7', 'utterance', '{"text": "tenant-a2 の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-29 21:19:09.147+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('16fc8e75-9ee5-43bd-9dd3-e75595f71ae6', 'tenant-a2', NULL, 'tenant-a2-ext-8', 'utterance', '{"text": "tenant-a2 の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-29 21:19:09.151+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9c25633b-0a84-40ba-8113-43263ffa210f', 'tenant-a2', NULL, 'tenant-a2-ext-9', 'utterance', '{"text": "tenant-a2 の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-29 21:19:09.153+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c60394fd-2f6c-4c4f-b73c-3171617dbab8', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-29 21:19:09.156+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('32cb7fd4-9db9-4344-ad1e-b812e31b4487', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-29 21:19:09.18+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b015484f-449f-4a8c-a3ca-1c2f8f76ee21', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-29 21:19:09.183+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9deda963-7bce-4907-bb6f-80c07a63a2b6', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-29 21:19:09.186+00', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('15bb4b9e-f721-463b-8d20-a8cfe473016a', 'tenant-a2', NULL, NULL, 'usage', '{"recallId": "d61bdf72-c9f6-4d2c-92af-79925ffb3a9e", "usedMemoryIds": ["2ea3bcd6-8d52-44b6-84ea-3e1c2d815346"]}', NULL, '2026-09-29 21:19:09.209+00', NULL, NULL, '{}');


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.outbox VALUES ('6b18b99c-d29b-4774-8d73-a663ae7319ac', 'tenant-a', 'extract', '{"observationId": "8a8e162c-6163-4aed-8387-c23974b275bd"}', '2026-09-29 21:19:08.668+00', NULL, NULL, 0, '2026-09-29 21:19:08.678+00', NULL, NULL, '2026-09-29 21:19:08.668+00');
INSERT INTO public.outbox VALUES ('4b373afa-c28b-4529-8dd6-ca333335c61c', 'tenant-a', 'extract', '{"observationId": "b035ff62-7ee1-40af-b367-c8437519ce6d"}', '2026-09-29 21:19:08.679+00', NULL, NULL, 0, '2026-09-29 21:19:08.685+00', NULL, NULL, '2026-09-29 21:19:08.679+00');
INSERT INTO public.outbox VALUES ('bf5eec30-fc89-4c48-8e36-63712e2db538', 'tenant-a', 'extract', '{"observationId": "b0bbb193-6758-4e88-916e-f9457ab225c5"}', '2026-09-29 21:19:08.686+00', NULL, NULL, 0, '2026-09-29 21:19:08.692+00', NULL, NULL, '2026-09-29 21:19:08.686+00');
INSERT INTO public.outbox VALUES ('2198cd6a-c561-4082-af76-bd4edd894bc2', 'tenant-a', 'extract', '{"observationId": "15776850-3aac-4027-9217-0d46efc78442"}', '2026-09-29 21:19:08.693+00', NULL, NULL, 0, '2026-09-29 21:19:08.697+00', NULL, NULL, '2026-09-29 21:19:08.693+00');
INSERT INTO public.outbox VALUES ('dd5e09a8-2a76-4962-9023-cdf221ec78ae', 'tenant-a', 'extract', '{"observationId": "abf7f084-e955-4de9-ba71-e2a6d2401a59"}', '2026-09-29 21:19:08.697+00', NULL, NULL, 0, '2026-09-29 21:19:08.701+00', NULL, NULL, '2026-09-29 21:19:08.697+00');
INSERT INTO public.outbox VALUES ('e12aeb78-5bdf-45fd-9af4-6d96a7feb166', 'tenant-a', 'extract', '{"observationId": "706d4062-1d1c-42e9-ad6f-576e962fe852"}', '2026-09-29 21:19:08.701+00', NULL, NULL, 0, '2026-09-29 21:19:08.705+00', NULL, NULL, '2026-09-29 21:19:08.701+00');
INSERT INTO public.outbox VALUES ('facdd184-369b-4742-bb6f-e0ee4bc5ef4d', 'tenant-a', 'extract', '{"observationId": "6438b316-cb4c-4262-bea5-71ff5b236d50"}', '2026-09-29 21:19:08.705+00', NULL, NULL, 0, '2026-09-29 21:19:08.709+00', NULL, NULL, '2026-09-29 21:19:08.705+00');
INSERT INTO public.outbox VALUES ('87218288-5dff-4167-8189-346feefa0622', 'tenant-a', 'extract', '{"observationId": "7f87ee73-f3de-4ecf-af32-de84ac094d6d"}', '2026-09-29 21:19:08.709+00', NULL, NULL, 0, '2026-09-29 21:19:08.713+00', NULL, NULL, '2026-09-29 21:19:08.709+00');
INSERT INTO public.outbox VALUES ('e0093842-897f-439f-a1a8-29aee2c9b729', 'tenant-a', 'extract', '{"observationId": "c1ff49f0-2232-494e-a4eb-b7e28e7c46b1"}', '2026-09-29 21:19:08.713+00', NULL, NULL, 0, '2026-09-29 21:19:08.72+00', NULL, NULL, '2026-09-29 21:19:08.713+00');
INSERT INTO public.outbox VALUES ('9434d8cc-c2b3-4ca5-aa04-071bcf564d93', 'tenant-a', 'extract', '{"observationId": "9688e6e4-35a5-42e6-8a14-1b94e504f7b3"}', '2026-09-29 21:19:08.721+00', NULL, NULL, 0, '2026-09-29 21:19:08.725+00', NULL, NULL, '2026-09-29 21:19:08.721+00');
INSERT INTO public.outbox VALUES ('7d7d69be-1604-468e-bb90-7ce4562f2c2b', 'tenant-a', 'extract', '{"observationId": "11e173f7-baf8-44b7-8475-484467f6ea3c"}', '2026-09-29 21:19:08.726+00', NULL, NULL, 0, '2026-09-29 21:19:08.729+00', NULL, NULL, '2026-09-29 21:19:08.726+00');
INSERT INTO public.outbox VALUES ('467536d4-5485-4580-851e-352a6690f70b', 'tenant-a', 'extract', '{"observationId": "d9b2cd55-2d66-4e0a-a6ab-022d72dff4b1"}', '2026-09-29 21:19:08.73+00', NULL, NULL, 0, '2026-09-29 21:19:08.734+00', NULL, NULL, '2026-09-29 21:19:08.73+00');
INSERT INTO public.outbox VALUES ('b5cb8f70-4367-49ef-abf1-71af8759f1fe', 'tenant-a', 'extract', '{"observationId": "c397cd2f-9a92-44c4-835f-5d2356437e9c"}', '2026-09-29 21:19:08.734+00', NULL, NULL, 0, '2026-09-29 21:19:08.738+00', NULL, NULL, '2026-09-29 21:19:08.734+00');
INSERT INTO public.outbox VALUES ('c5c71292-cb6c-40f1-949e-a379364f3410', 'tenant-a', 'extract', '{"observationId": "89b67872-9cf0-43c4-8995-9c0bec34a05c"}', '2026-09-29 21:19:08.738+00', NULL, NULL, 0, '2026-09-29 21:19:08.742+00', NULL, NULL, '2026-09-29 21:19:08.738+00');
INSERT INTO public.outbox VALUES ('b4bc54ea-87c7-47ef-b124-2fead0ee1b99', 'tenant-a', 'extract', '{"observationId": "ca4b8cd8-4a09-412c-988d-43f733fa9c1e"}', '2026-09-29 21:19:08.743+00', NULL, NULL, 0, '2026-09-29 21:19:08.747+00', NULL, NULL, '2026-09-29 21:19:08.743+00');
INSERT INTO public.outbox VALUES ('093e98a6-b28f-4f1b-b34e-e287d9815a04', 'tenant-a', 'extract', '{"observationId": "bee79136-a1c1-4665-9f61-0c65c07a7252"}', '2026-09-29 21:19:08.748+00', NULL, NULL, 0, '2026-09-29 21:19:08.752+00', NULL, NULL, '2026-09-29 21:19:08.748+00');
INSERT INTO public.outbox VALUES ('129035e5-188a-4875-9f55-8f0b8fa6f528', 'tenant-a', 'extract', '{"observationId": "13e496d2-9c05-4187-9753-f204298d1171"}', '2026-09-29 21:19:08.752+00', NULL, NULL, 0, '2026-09-29 21:19:08.756+00', NULL, NULL, '2026-09-29 21:19:08.752+00');
INSERT INTO public.outbox VALUES ('2f3e14c4-1bc9-48f0-ba6d-07d5d0cc59d6', 'tenant-a', 'extract', '{"observationId": "07a628c9-16dd-476e-be91-70f344679082"}', '2026-09-29 21:19:08.756+00', NULL, NULL, 0, '2026-09-29 21:19:08.759+00', NULL, NULL, '2026-09-29 21:19:08.756+00');
INSERT INTO public.outbox VALUES ('9606f972-1612-4420-bac4-0cb37dabc65d', 'tenant-a', 'extract', '{"observationId": "6532b6b6-32de-4e31-b849-fed93b5482c1"}', '2026-09-29 21:19:08.759+00', NULL, NULL, 0, '2026-09-29 21:19:08.762+00', NULL, NULL, '2026-09-29 21:19:08.759+00');
INSERT INTO public.outbox VALUES ('d92dc8f0-2b34-4ced-ac00-f2d684b76aec', 'tenant-a', 'extract', '{"observationId": "47fcfc91-7cd0-4f0b-8b82-fed236f534c4"}', '2026-09-29 21:19:08.763+00', NULL, NULL, 0, '2026-09-29 21:19:08.766+00', NULL, NULL, '2026-09-29 21:19:08.763+00');
INSERT INTO public.outbox VALUES ('59b4a141-2101-4771-8df7-7c329938bc3d', 'tenant-a', 'extract', '{"observationId": "8f97a6e0-4c17-4acb-b739-1e7ace4189ac"}', '2026-09-29 21:19:08.767+00', NULL, NULL, 0, '2026-09-29 21:19:08.77+00', NULL, NULL, '2026-09-29 21:19:08.767+00');
INSERT INTO public.outbox VALUES ('4e01a312-96c7-441c-8e18-aa219e78276d', 'tenant-a', 'extract', '{"observationId": "274e9155-126a-40f5-8cd7-68fb71bd732d"}', '2026-09-29 21:19:08.77+00', NULL, NULL, 0, '2026-09-29 21:19:08.773+00', NULL, NULL, '2026-09-29 21:19:08.77+00');
INSERT INTO public.outbox VALUES ('5a8135a3-9f42-4833-8a2d-b4cf0ea19ea2', 'tenant-a', 'extract', '{"observationId": "c7b3a269-f35f-4d4d-a91c-bc3da1e1cd4d"}', '2026-09-29 21:19:08.774+00', NULL, NULL, 0, '2026-09-29 21:19:08.777+00', NULL, NULL, '2026-09-29 21:19:08.774+00');
INSERT INTO public.outbox VALUES ('76d16987-2d4f-4599-891c-5132b24bf9ec', 'tenant-a', 'extract', '{"observationId": "baf68620-4987-489f-b538-a777dc0da466"}', '2026-09-29 21:19:08.777+00', NULL, NULL, 0, '2026-09-29 21:19:08.781+00', NULL, NULL, '2026-09-29 21:19:08.777+00');
INSERT INTO public.outbox VALUES ('e487ba5b-c43a-4270-bf6d-30bb01bf5ff5', 'tenant-a', 'extract', '{"observationId": "d7b1d29b-dfd3-4468-8d02-1ecb4dc41d2e"}', '2026-09-29 21:19:08.781+00', NULL, NULL, 0, '2026-09-29 21:19:08.785+00', NULL, NULL, '2026-09-29 21:19:08.781+00');
INSERT INTO public.outbox VALUES ('6137d2b3-e979-4652-8986-3664b4c91e99', 'tenant-a', 'embed', '{"memoryId": "e0081a9b-ab0b-4d2e-aace-2fb878388ee3"}', '2026-09-29 21:19:08.674+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.789+00', NULL, NULL, '2026-09-29 21:19:08.674+00');
INSERT INTO public.outbox VALUES ('fdeb5939-227a-4e43-aa17-4ccd7380d73e', 'tenant-a', 'embed', '{"memoryId": "a46ec3f5-43bf-4d94-894f-8fb2de2de3f6"}', '2026-09-29 21:19:08.682+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.791+00', NULL, NULL, '2026-09-29 21:19:08.682+00');
INSERT INTO public.outbox VALUES ('9077981b-c0a6-4cba-a880-b9161d010320', 'tenant-a', 'embed', '{"memoryId": "897a41c6-5c2d-4f4d-add6-3b099d95114b"}', '2026-09-29 21:19:08.688+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.794+00', NULL, NULL, '2026-09-29 21:19:08.688+00');
INSERT INTO public.outbox VALUES ('d93c97e6-00e5-4e06-a41d-21fd2c639426', 'tenant-a', 'embed', '{"memoryId": "f470586c-8af7-4d6c-895d-3f2884d38869"}', '2026-09-29 21:19:08.695+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.796+00', NULL, NULL, '2026-09-29 21:19:08.695+00');
INSERT INTO public.outbox VALUES ('8ffc3a4c-4750-47f8-881f-676ec80dd97e', 'tenant-a', 'embed', '{"memoryId": "8ccbe3e6-666d-407c-8e9e-2bfc8e0d7247"}', '2026-09-29 21:19:08.699+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.798+00', NULL, NULL, '2026-09-29 21:19:08.699+00');
INSERT INTO public.outbox VALUES ('18d394b4-1a31-4a60-aacb-4f41de58a118', 'tenant-a', 'embed', '{"memoryId": "db0bc183-c53f-417c-b4c1-025cd7474242"}', '2026-09-29 21:19:08.703+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.8+00', NULL, NULL, '2026-09-29 21:19:08.703+00');
INSERT INTO public.outbox VALUES ('41534fed-4a3f-4f16-8877-6a6e898ce4a5', 'tenant-a', 'embed', '{"memoryId": "149ba346-7bb5-4479-b380-01b7520b1518"}', '2026-09-29 21:19:08.707+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.802+00', NULL, NULL, '2026-09-29 21:19:08.707+00');
INSERT INTO public.outbox VALUES ('5a43806e-778d-4887-8024-6142dc5b47b0', 'tenant-a', 'embed', '{"memoryId": "3a1709cc-8637-4bf5-8dee-39dada23cb30"}', '2026-09-29 21:19:08.711+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.804+00', NULL, NULL, '2026-09-29 21:19:08.711+00');
INSERT INTO public.outbox VALUES ('10e4c538-b9e2-4cf8-a002-6676b9924613', 'tenant-a', 'embed', '{"memoryId": "f74cbb10-2e47-42d6-a35c-10b63088ecd8"}', '2026-09-29 21:19:08.715+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.807+00', NULL, NULL, '2026-09-29 21:19:08.715+00');
INSERT INTO public.outbox VALUES ('67aa2ace-0d55-430b-bc2d-fa361087c227', 'tenant-a', 'embed', '{"memoryId": "8f215c06-e527-47ea-8294-c72de198b4ef"}', '2026-09-29 21:19:08.723+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.812+00', NULL, NULL, '2026-09-29 21:19:08.723+00');
INSERT INTO public.outbox VALUES ('6d1b7e21-7db7-460d-b47e-7ad32b15e4e9', 'tenant-a', 'embed', '{"memoryId": "c5257309-a313-4edf-8710-5239d035fd2a"}', '2026-09-29 21:19:08.728+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.814+00', NULL, NULL, '2026-09-29 21:19:08.728+00');
INSERT INTO public.outbox VALUES ('a88ddb6b-7697-4c61-afe1-c0476f88ce69', 'tenant-a', 'embed', '{"memoryId": "f1f4150b-0690-465b-9191-cdf95b34f776"}', '2026-09-29 21:19:08.732+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.816+00', NULL, NULL, '2026-09-29 21:19:08.732+00');
INSERT INTO public.outbox VALUES ('92779764-e5af-4192-bc85-81178b5dd142', 'tenant-a', 'embed', '{"memoryId": "4ce790df-4e6f-4fe7-aa9e-aa9a89f03ca9"}', '2026-09-29 21:19:08.736+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.818+00', NULL, NULL, '2026-09-29 21:19:08.736+00');
INSERT INTO public.outbox VALUES ('8c919f72-0478-4e3a-adda-f2f05f351cb3', 'tenant-a', 'embed', '{"memoryId": "ee33db96-defd-4b3b-949b-77a1e65dab86"}', '2026-09-29 21:19:08.74+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.82+00', NULL, NULL, '2026-09-29 21:19:08.74+00');
INSERT INTO public.outbox VALUES ('d4082c07-5728-4928-9eb0-d3aa60eaffd7', 'tenant-a', 'embed', '{"memoryId": "77445d98-551f-4602-89ca-170a70a6a7d8"}', '2026-09-29 21:19:08.745+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.822+00', NULL, NULL, '2026-09-29 21:19:08.745+00');
INSERT INTO public.outbox VALUES ('e4b8b5e5-6b57-467c-a06e-ecd98e73cd69', 'tenant-a', 'embed', '{"memoryId": "8616afb7-77f5-48ef-b83a-8fa785553645"}', '2026-09-29 21:19:08.75+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.824+00', NULL, NULL, '2026-09-29 21:19:08.75+00');
INSERT INTO public.outbox VALUES ('a96323be-48d7-41bf-97c5-59d836469a87', 'tenant-a', 'embed', '{"memoryId": "fd108a3f-04aa-49a3-ac6d-d59bac1508bc"}', '2026-09-29 21:19:08.754+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.827+00', NULL, NULL, '2026-09-29 21:19:08.754+00');
INSERT INTO public.outbox VALUES ('f5c55955-0b03-4a50-90e2-596bad22c1ee', 'tenant-a', 'embed', '{"memoryId": "9a2bcf9e-4b48-49f9-84b6-30bd672a47da"}', '2026-09-29 21:19:08.757+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.828+00', NULL, NULL, '2026-09-29 21:19:08.757+00');
INSERT INTO public.outbox VALUES ('8ac2fab8-34f9-43ee-bec5-520cd4707df1', 'tenant-a', 'embed', '{"memoryId": "18825385-0942-41ff-b004-0dad509b8bf4"}', '2026-09-29 21:19:08.761+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.83+00', NULL, NULL, '2026-09-29 21:19:08.761+00');
INSERT INTO public.outbox VALUES ('eb60ef3d-89f3-4512-a92e-a3193fc82c27', 'tenant-a', 'embed', '{"memoryId": "37614f7f-d6cb-44b6-a392-d1dba00ae236"}', '2026-09-29 21:19:08.765+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.832+00', NULL, NULL, '2026-09-29 21:19:08.765+00');
INSERT INTO public.outbox VALUES ('1acd91a9-24ac-431b-a4c2-376f77bc568b', 'tenant-a', 'embed', '{"memoryId": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}', '2026-09-29 21:19:08.768+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.834+00', NULL, NULL, '2026-09-29 21:19:08.768+00');
INSERT INTO public.outbox VALUES ('fc3d878b-8190-41de-960e-a4c6eb6d984a', 'tenant-a', 'embed', '{"memoryId": "65826ca6-3ea1-409b-877a-cbeb6cc2178c"}', '2026-09-29 21:19:08.772+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.836+00', NULL, NULL, '2026-09-29 21:19:08.772+00');
INSERT INTO public.outbox VALUES ('64f2f9d4-ad0f-44db-b107-f2d095caa9ac', 'tenant-a', 'embed', '{"memoryId": "b971cb6f-4f8f-489f-a92e-f4b5399a2b12"}', '2026-09-29 21:19:08.775+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.838+00', NULL, NULL, '2026-09-29 21:19:08.775+00');
INSERT INTO public.outbox VALUES ('283bc9fb-a678-43e4-9fd8-3d9e82560d78', 'tenant-a', 'embed', '{"memoryId": "22328c13-90e3-44a3-994e-fa03fce4715c"}', '2026-09-29 21:19:08.779+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, '2026-09-29 21:19:08.84+00', NULL, NULL, '2026-09-29 21:19:08.779+00');
INSERT INTO public.outbox VALUES ('510cbe66-f5ee-4382-9342-98840ddfdb23', 'tenant-a', 'embed', '{"memoryId": "b1bdc4cb-d784-4f00-86b3-b8e4175b797d"}', '2026-09-29 21:19:08.783+00', '2026-09-29 21:19:08.785+00', 'runtime.tick', 1, NULL, '2026-09-29 21:19:08.841+00', 'fixture: embedding provider failure', '2026-09-29 21:19:08.783+00');
INSERT INTO public.outbox VALUES ('c6f63b63-c774-40e4-9ad4-6f804094de71', 'tenant-a', 'embed', '{"memoryId": "65da3405-5041-492f-af51-311727b215f9"}', '2026-09-29 21:19:08.844+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:08.844+00');
INSERT INTO public.outbox VALUES ('d06ddfc9-3b41-47f7-8f69-6bae3c3fbd83', 'tenant-a', 'extract', '{"observationId": "906514f6-b0e3-4225-9915-04ef002a634f"}', '2026-09-29 21:19:08.842+00', NULL, NULL, 0, '2026-09-29 21:19:08.845+00', NULL, NULL, '2026-09-29 21:19:08.842+00');
INSERT INTO public.outbox VALUES ('6fa052c9-b75c-465e-96ca-c7cca0212038', 'tenant-a', 'embed', '{"memoryId": "c35c9683-2387-4754-8aa2-77f7f9e132bc"}', '2026-09-29 21:19:08.847+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:08.847+00');
INSERT INTO public.outbox VALUES ('f343b541-ef95-4431-acb7-dd93fdcee251', 'tenant-a', 'extract', '{"observationId": "043a4fc9-f13d-41bf-b5a9-d45fcd88a8ed"}', '2026-09-29 21:19:08.846+00', NULL, NULL, 0, '2026-09-29 21:19:08.849+00', NULL, NULL, '2026-09-29 21:19:08.846+00');
INSERT INTO public.outbox VALUES ('675ed130-ef7c-4afc-b6a5-b2ac8c8d31ad', 'tenant-a', 'embed', '{"memoryId": "f5164112-4633-45d4-9b50-060b98958dd4"}', '2026-09-29 21:19:08.851+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:08.851+00');
INSERT INTO public.outbox VALUES ('021b1667-2085-47b6-afc4-2bbbed5a8471', 'tenant-a', 'extract', '{"observationId": "75ec33b6-7e89-4d5c-9c95-862af04e2e1c"}', '2026-09-29 21:19:08.849+00', NULL, NULL, 0, '2026-09-29 21:19:08.853+00', NULL, NULL, '2026-09-29 21:19:08.849+00');
INSERT INTO public.outbox VALUES ('90730269-a9cd-413f-ac94-55e0433bea82', 'tenant-b', 'extract', '{"observationId": "8efb7ec9-c77a-48e5-9262-2a0ca64d64e4"}', '2026-09-29 21:19:08.89+00', NULL, NULL, 0, '2026-09-29 21:19:08.893+00', NULL, NULL, '2026-09-29 21:19:08.89+00');
INSERT INTO public.outbox VALUES ('976cd5b7-6d03-4afb-82cf-ad375b8ca0bf', 'tenant-b', 'extract', '{"observationId": "cd61fbcb-9f78-47c9-903c-1eb5cd9561a7"}', '2026-09-29 21:19:08.894+00', NULL, NULL, 0, '2026-09-29 21:19:08.897+00', NULL, NULL, '2026-09-29 21:19:08.894+00');
INSERT INTO public.outbox VALUES ('8882b42d-4c16-4fd0-8aa4-3cf9db8f45c2', 'tenant-b', 'extract', '{"observationId": "531dac99-af73-4f54-ba8a-27372bb1dd68"}', '2026-09-29 21:19:08.898+00', NULL, NULL, 0, '2026-09-29 21:19:08.901+00', NULL, NULL, '2026-09-29 21:19:08.898+00');
INSERT INTO public.outbox VALUES ('2eb6b9a4-5f7d-487b-9945-3cacbb2a47a7', 'tenant-b', 'extract', '{"observationId": "e3c68bda-385c-4e10-b81f-698cea62de03"}', '2026-09-29 21:19:08.901+00', NULL, NULL, 0, '2026-09-29 21:19:08.905+00', NULL, NULL, '2026-09-29 21:19:08.901+00');
INSERT INTO public.outbox VALUES ('12cf43e5-0073-4c66-a1f1-ae9145e32a43', 'tenant-b', 'extract', '{"observationId": "75674ce3-6231-4247-a551-527d9494337f"}', '2026-09-29 21:19:08.905+00', NULL, NULL, 0, '2026-09-29 21:19:08.908+00', NULL, NULL, '2026-09-29 21:19:08.905+00');
INSERT INTO public.outbox VALUES ('cf2dfa21-6b4a-4cf7-9c7c-40f5d30c3a74', 'tenant-b', 'extract', '{"observationId": "e2c90494-a1bd-43e8-9d7a-69126471ce3d"}', '2026-09-29 21:19:08.909+00', NULL, NULL, 0, '2026-09-29 21:19:08.912+00', NULL, NULL, '2026-09-29 21:19:08.909+00');
INSERT INTO public.outbox VALUES ('4167aab5-b57d-4def-b6bc-d1750fbd10fa', 'tenant-b', 'extract', '{"observationId": "43893183-ea94-4fa3-a2d3-a3931f62800b"}', '2026-09-29 21:19:08.912+00', NULL, NULL, 0, '2026-09-29 21:19:08.916+00', NULL, NULL, '2026-09-29 21:19:08.912+00');
INSERT INTO public.outbox VALUES ('726bc479-c7cd-4c52-bddc-6b1e420d0cfd', 'tenant-b', 'extract', '{"observationId": "51e383ab-8e8b-4306-9db1-6bddee6393de"}', '2026-09-29 21:19:08.916+00', NULL, NULL, 0, '2026-09-29 21:19:08.92+00', NULL, NULL, '2026-09-29 21:19:08.916+00');
INSERT INTO public.outbox VALUES ('5084d312-6f73-4b05-b7d7-6d4599fbe309', 'tenant-b', 'embed', '{"memoryId": "34bc6c50-4daf-455e-93a8-c0810d9af8d2"}', '2026-09-29 21:19:08.892+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.962+00', NULL, NULL, '2026-09-29 21:19:08.892+00');
INSERT INTO public.outbox VALUES ('4f5cdbe0-4fef-4ef8-9b95-d13b71fe6c16', 'tenant-b', 'extract', '{"observationId": "f3cf3f85-9c47-4e80-b705-933d585658f9"}', '2026-09-29 21:19:08.92+00', NULL, NULL, 0, '2026-09-29 21:19:08.924+00', NULL, NULL, '2026-09-29 21:19:08.92+00');
INSERT INTO public.outbox VALUES ('c603c921-7dc4-4476-a8ce-de46f41c6e10', 'tenant-b', 'extract', '{"observationId": "7c07ab26-9013-43f2-a0b8-0d3575981279"}', '2026-09-29 21:19:08.924+00', NULL, NULL, 0, '2026-09-29 21:19:08.927+00', NULL, NULL, '2026-09-29 21:19:08.924+00');
INSERT INTO public.outbox VALUES ('c11da319-af5d-44d1-bc48-e38bbcca4ef9', 'tenant-b', 'extract', '{"observationId": "56839a6d-76ec-41c8-9b00-60c5d15c535f"}', '2026-09-29 21:19:08.928+00', NULL, NULL, 0, '2026-09-29 21:19:08.931+00', NULL, NULL, '2026-09-29 21:19:08.928+00');
INSERT INTO public.outbox VALUES ('625ae0f6-2a75-4071-8b0a-3d3d8214f112', 'tenant-b', 'extract', '{"observationId": "8a6b99cc-bb57-48f2-ba45-892febca79a2"}', '2026-09-29 21:19:08.931+00', NULL, NULL, 0, '2026-09-29 21:19:08.935+00', NULL, NULL, '2026-09-29 21:19:08.931+00');
INSERT INTO public.outbox VALUES ('354315e7-34a6-4e4d-b0f4-d98e8a90e6aa', 'tenant-b', 'extract', '{"observationId": "48578e71-dbce-42b5-ba25-34fb24e113ef"}', '2026-09-29 21:19:08.935+00', NULL, NULL, 0, '2026-09-29 21:19:08.938+00', NULL, NULL, '2026-09-29 21:19:08.935+00');
INSERT INTO public.outbox VALUES ('c162bdda-b26f-40d0-8c68-40adbeeda27e', 'tenant-b', 'extract', '{"observationId": "fb54fe23-f81b-444f-80a8-69bfed6d310f"}', '2026-09-29 21:19:08.938+00', NULL, NULL, 0, '2026-09-29 21:19:08.942+00', NULL, NULL, '2026-09-29 21:19:08.938+00');
INSERT INTO public.outbox VALUES ('7da4fea8-0c94-4ead-b9f1-6984777570dd', 'tenant-b', 'extract', '{"observationId": "401a6b2a-e77e-452d-9180-b6cc1e6e793a"}', '2026-09-29 21:19:08.942+00', NULL, NULL, 0, '2026-09-29 21:19:08.946+00', NULL, NULL, '2026-09-29 21:19:08.942+00');
INSERT INTO public.outbox VALUES ('5f440b4a-cf0e-40b7-bd6f-67b2a4525998', 'tenant-b', 'extract', '{"observationId": "4786d953-f28f-4973-bce3-5ba5173214f0"}', '2026-09-29 21:19:08.946+00', NULL, NULL, 0, '2026-09-29 21:19:08.949+00', NULL, NULL, '2026-09-29 21:19:08.946+00');
INSERT INTO public.outbox VALUES ('8cace197-2bda-43e5-99d5-d0faab26920d', 'tenant-b', 'extract', '{"observationId": "f665cf43-f902-4eef-a8df-63b6e7439b8a"}', '2026-09-29 21:19:08.95+00', NULL, NULL, 0, '2026-09-29 21:19:08.953+00', NULL, NULL, '2026-09-29 21:19:08.95+00');
INSERT INTO public.outbox VALUES ('7b3288c1-5480-4565-b976-3a0e6aed943d', 'tenant-b', 'extract', '{"observationId": "f31c9fef-4429-4f70-ab3b-58b430ee8f79"}', '2026-09-29 21:19:08.953+00', NULL, NULL, 0, '2026-09-29 21:19:08.956+00', NULL, NULL, '2026-09-29 21:19:08.953+00');
INSERT INTO public.outbox VALUES ('32a15e30-179f-4ffb-b676-b8f9125eb266', 'tenant-b', 'extract', '{"observationId": "e37b2220-cd40-4c73-abb9-d41c35d034b1"}', '2026-09-29 21:19:08.956+00', NULL, NULL, 0, '2026-09-29 21:19:08.959+00', NULL, NULL, '2026-09-29 21:19:08.956+00');
INSERT INTO public.outbox VALUES ('56865b07-7142-4684-84e7-f8bfd94be596', 'tenant-b', 'embed', '{"memoryId": "b2b96f0e-a4b7-4073-9829-a62a14b5a6a8"}', '2026-09-29 21:19:08.895+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.965+00', NULL, NULL, '2026-09-29 21:19:08.895+00');
INSERT INTO public.outbox VALUES ('4a887086-7e91-4ee2-9c97-dc8b37316ee5', 'tenant-b', 'embed', '{"memoryId": "8ee354d2-7ac4-4c57-9d74-e58d0b8c0a58"}', '2026-09-29 21:19:08.899+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.967+00', NULL, NULL, '2026-09-29 21:19:08.899+00');
INSERT INTO public.outbox VALUES ('73ecd07a-ab19-457c-9e32-c5b426fdeb84', 'tenant-b', 'embed', '{"memoryId": "40156ace-7cd4-4039-acf9-329df0ab0023"}', '2026-09-29 21:19:08.903+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.969+00', NULL, NULL, '2026-09-29 21:19:08.903+00');
INSERT INTO public.outbox VALUES ('88bc6114-9041-438a-bb96-a4ca45a9df4c', 'tenant-b', 'embed', '{"memoryId": "b8aed883-24b6-4e41-b086-5fdfc3f0c661"}', '2026-09-29 21:19:08.907+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.971+00', NULL, NULL, '2026-09-29 21:19:08.907+00');
INSERT INTO public.outbox VALUES ('f88d405d-2e33-4e96-97f0-162b0497f07a', 'tenant-b', 'embed', '{"memoryId": "006a5c23-3369-4987-a892-6ba3458bbc0f"}', '2026-09-29 21:19:08.91+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.973+00', NULL, NULL, '2026-09-29 21:19:08.91+00');
INSERT INTO public.outbox VALUES ('773b3b5c-b33f-4c08-a034-fa5ac36d3dde', 'tenant-b', 'embed', '{"memoryId": "06e363fc-41f9-423b-84cf-57c3948d536f"}', '2026-09-29 21:19:08.914+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.975+00', NULL, NULL, '2026-09-29 21:19:08.914+00');
INSERT INTO public.outbox VALUES ('f2677408-7d76-48b2-9748-f4c59becbc1f', 'tenant-b', 'embed', '{"memoryId": "914f6a5a-33b7-4a76-99bc-822d89a29b7e"}', '2026-09-29 21:19:08.918+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.977+00', NULL, NULL, '2026-09-29 21:19:08.918+00');
INSERT INTO public.outbox VALUES ('f3cb2f66-6e39-4c10-9a9f-4761b0afbf1d', 'tenant-b', 'embed', '{"memoryId": "1ecb2047-167b-45a7-af37-7559bd95ece3"}', '2026-09-29 21:19:08.922+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.979+00', NULL, NULL, '2026-09-29 21:19:08.922+00');
INSERT INTO public.outbox VALUES ('b9f1ecfe-a1ca-4678-9a7c-f42ae4db31ee', 'tenant-b', 'embed', '{"memoryId": "d1c301c6-60d9-48f1-bf66-ab932c3a9f26"}', '2026-09-29 21:19:08.926+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.981+00', NULL, NULL, '2026-09-29 21:19:08.926+00');
INSERT INTO public.outbox VALUES ('d0eea299-d837-4ed4-8557-f0e9a24e7f01', 'tenant-b', 'embed', '{"memoryId": "95212a43-882e-4e2c-ac32-b18f7877d654"}', '2026-09-29 21:19:08.929+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.983+00', NULL, NULL, '2026-09-29 21:19:08.929+00');
INSERT INTO public.outbox VALUES ('25549e49-1ae5-49d7-8ad3-ed53a362c330', 'tenant-b', 'embed', '{"memoryId": "43ae5893-9b66-4023-aac5-500a87b70b05"}', '2026-09-29 21:19:08.933+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.985+00', NULL, NULL, '2026-09-29 21:19:08.933+00');
INSERT INTO public.outbox VALUES ('24252a91-1648-4899-a613-f2f1ee14f96b', 'tenant-b', 'embed', '{"memoryId": "b653da21-8dd6-4080-82dc-793dab1a8c15"}', '2026-09-29 21:19:08.937+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.987+00', NULL, NULL, '2026-09-29 21:19:08.937+00');
INSERT INTO public.outbox VALUES ('6ab47c60-9ef2-4edc-b69c-91f8d73dc281', 'tenant-b', 'embed', '{"memoryId": "88672c65-0318-46aa-9979-efb590afe38a"}', '2026-09-29 21:19:08.941+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.989+00', NULL, NULL, '2026-09-29 21:19:08.941+00');
INSERT INTO public.outbox VALUES ('e428bf16-2436-4b39-84a6-ab659c2b2ac3', 'tenant-b', 'embed', '{"memoryId": "78f77025-74b7-4f26-9f7f-42ee84b9744c"}', '2026-09-29 21:19:08.944+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.991+00', NULL, NULL, '2026-09-29 21:19:08.944+00');
INSERT INTO public.outbox VALUES ('9b2b8f12-2091-4b20-a8e9-7e98bdbc9a0a', 'tenant-b', 'embed', '{"memoryId": "e06b5dcf-dfa0-4051-922c-f17c74d72651"}', '2026-09-29 21:19:08.948+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.993+00', NULL, NULL, '2026-09-29 21:19:08.948+00');
INSERT INTO public.outbox VALUES ('158ae182-bf14-4850-ba0d-a4c115726da6', 'tenant-b', 'embed', '{"memoryId": "e2081c0b-cf18-4bbe-9a9c-44ef2a48dabe"}', '2026-09-29 21:19:08.951+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.995+00', NULL, NULL, '2026-09-29 21:19:08.951+00');
INSERT INTO public.outbox VALUES ('c6aa4723-c600-4ed6-9c5c-20c948ab082b', 'tenant-b', 'embed', '{"memoryId": "e5b7d4de-20f6-49f9-9c9f-f8d7b52db74a"}', '2026-09-29 21:19:08.954+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, '2026-09-29 21:19:08.996+00', NULL, NULL, '2026-09-29 21:19:08.954+00');
INSERT INTO public.outbox VALUES ('5c835a3a-b35f-4bbd-8eec-40b02630fad3', 'tenant-b', 'embed', '{"memoryId": "a557b10f-571d-481a-ab40-f77579405ccc"}', '2026-09-29 21:19:08.958+00', '2026-09-29 21:19:08.96+00', 'runtime.tick', 1, NULL, '2026-09-29 21:19:08.998+00', 'fixture: embedding provider failure', '2026-09-29 21:19:08.958+00');
INSERT INTO public.outbox VALUES ('a9a15015-5b83-49c5-82f7-39b5d753a600', 'tenant-b', 'embed', '{"memoryId": "370a2fd7-0122-4f2c-8067-33b2105b749d"}', '2026-09-29 21:19:09+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09+00');
INSERT INTO public.outbox VALUES ('f6f05b85-6e35-4fbd-8743-c1bb1469efe0', 'tenant-b', 'extract', '{"observationId": "43a023e0-7cc6-4ea2-be6e-5574676665b2"}', '2026-09-29 21:19:08.998+00', NULL, NULL, 0, '2026-09-29 21:19:09.002+00', NULL, NULL, '2026-09-29 21:19:08.998+00');
INSERT INTO public.outbox VALUES ('26bad82c-8604-4085-bfee-88be8bf933f9', 'tenant-b', 'embed', '{"memoryId": "c671fe01-0eb3-4ec6-a4d3-139226e4f756"}', '2026-09-29 21:19:09.003+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.003+00');
INSERT INTO public.outbox VALUES ('97d80285-0e7e-4db1-96fa-8a52ab39a58d', 'tenant-b', 'extract', '{"observationId": "bfdd12a5-6077-42ad-a650-d14d2a410282"}', '2026-09-29 21:19:09.002+00', NULL, NULL, 0, '2026-09-29 21:19:09.005+00', NULL, NULL, '2026-09-29 21:19:09.002+00');
INSERT INTO public.outbox VALUES ('6e639d96-05ea-43ab-8b41-64827a9ee0c3', 'tenant-b', 'embed', '{"memoryId": "a6369cc6-0d23-4855-b2b2-9c17bb601ac4"}', '2026-09-29 21:19:09.007+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.007+00');
INSERT INTO public.outbox VALUES ('a9d7a111-7d15-4145-9a65-613f5b8babb2', 'tenant-b', 'extract', '{"observationId": "6d3cc096-b9de-480c-91e2-4b5ac3fcdf83"}', '2026-09-29 21:19:09.005+00', NULL, NULL, 0, '2026-09-29 21:19:09.008+00', NULL, NULL, '2026-09-29 21:19:09.005+00');
INSERT INTO public.outbox VALUES ('2feb6948-9d08-4a80-ae65-349c16a0fa44', 'tenant-c', 'extract', '{"observationId": "0facdd38-35cc-4543-965d-ae3ae08040fa"}', '2026-09-29 21:19:09.031+00', NULL, NULL, 0, '2026-09-29 21:19:09.034+00', NULL, NULL, '2026-09-29 21:19:09.031+00');
INSERT INTO public.outbox VALUES ('89d16141-8897-4c7c-bdb1-a8a3e1e1aa40', 'tenant-c', 'extract', '{"observationId": "644d968f-6494-46ea-8a12-ff4e074ffe92"}', '2026-09-29 21:19:09.034+00', NULL, NULL, 0, '2026-09-29 21:19:09.037+00', NULL, NULL, '2026-09-29 21:19:09.034+00');
INSERT INTO public.outbox VALUES ('b926a1e7-b1da-4c13-a4bf-58c3a05366ff', 'tenant-c', 'extract', '{"observationId": "9bcb410b-077c-43da-b04d-e58368dc38aa"}', '2026-09-29 21:19:09.037+00', NULL, NULL, 0, '2026-09-29 21:19:09.04+00', NULL, NULL, '2026-09-29 21:19:09.037+00');
INSERT INTO public.outbox VALUES ('2a3a7ebd-459c-4db0-a6d0-6e596d0e4d07', 'tenant-c', 'extract', '{"observationId": "9196f304-ce8b-4c1c-ac89-c6b43c024e4e"}', '2026-09-29 21:19:09.041+00', NULL, NULL, 0, '2026-09-29 21:19:09.044+00', NULL, NULL, '2026-09-29 21:19:09.041+00');
INSERT INTO public.outbox VALUES ('104f2cf3-a3cb-40ec-b29c-05fa2094bdee', 'tenant-c', 'extract', '{"observationId": "0c94269a-8cad-4080-8b0f-575cc0d63c8a"}', '2026-09-29 21:19:09.044+00', NULL, NULL, 0, '2026-09-29 21:19:09.047+00', NULL, NULL, '2026-09-29 21:19:09.044+00');
INSERT INTO public.outbox VALUES ('1963de55-149f-49f9-85fa-5720ab179b1a', 'tenant-c', 'extract', '{"observationId": "610153bf-c054-4e78-8fb5-7d3e951402b5"}', '2026-09-29 21:19:09.047+00', NULL, NULL, 0, '2026-09-29 21:19:09.05+00', NULL, NULL, '2026-09-29 21:19:09.047+00');
INSERT INTO public.outbox VALUES ('0c28808d-d2fc-4527-bb41-c6097274a687', 'tenant-c', 'extract', '{"observationId": "756cd911-410b-449b-b958-134c6e625b2c"}', '2026-09-29 21:19:09.05+00', NULL, NULL, 0, '2026-09-29 21:19:09.053+00', NULL, NULL, '2026-09-29 21:19:09.05+00');
INSERT INTO public.outbox VALUES ('1bbf2a79-7b23-4d42-b042-10ce68f23ff8', 'tenant-c', 'extract', '{"observationId": "09766e6d-407a-4bae-a3e9-6d6babf94119"}', '2026-09-29 21:19:09.053+00', NULL, NULL, 0, '2026-09-29 21:19:09.056+00', NULL, NULL, '2026-09-29 21:19:09.053+00');
INSERT INTO public.outbox VALUES ('18952691-1241-4ac0-8468-c9943da8c870', 'tenant-c', 'extract', '{"observationId": "d5ddf8d1-4f81-49f3-bac9-852956fb3693"}', '2026-09-29 21:19:09.056+00', NULL, NULL, 0, '2026-09-29 21:19:09.059+00', NULL, NULL, '2026-09-29 21:19:09.056+00');
INSERT INTO public.outbox VALUES ('4993c4d9-7256-4ffb-a24f-0f0a401783b1', 'tenant-c', 'extract', '{"observationId": "749cde64-66b2-4a6d-ad6a-bd4fefcca044"}', '2026-09-29 21:19:09.059+00', NULL, NULL, 0, '2026-09-29 21:19:09.062+00', NULL, NULL, '2026-09-29 21:19:09.059+00');
INSERT INTO public.outbox VALUES ('59af3923-cab9-4705-addf-bba2e8a5ab72', 'tenant-c', 'extract', '{"observationId": "e2263584-7278-4538-bb60-e6adb182d2b4"}', '2026-09-29 21:19:09.062+00', NULL, NULL, 0, '2026-09-29 21:19:09.065+00', NULL, NULL, '2026-09-29 21:19:09.062+00');
INSERT INTO public.outbox VALUES ('08d63997-9566-434a-ad22-ba2de1db54fd', 'tenant-c', 'extract', '{"observationId": "4e969f2f-f3cf-4725-bf0f-6652e6b6bbb7"}', '2026-09-29 21:19:09.065+00', NULL, NULL, 0, '2026-09-29 21:19:09.068+00', NULL, NULL, '2026-09-29 21:19:09.065+00');
INSERT INTO public.outbox VALUES ('42ed4945-bcf5-47e2-a1f1-8ee1103e49d4', 'tenant-c', 'extract', '{"observationId": "7688f2bb-c599-4ffd-9781-2ef918cce1d1"}', '2026-09-29 21:19:09.069+00', NULL, NULL, 0, '2026-09-29 21:19:09.071+00', NULL, NULL, '2026-09-29 21:19:09.069+00');
INSERT INTO public.outbox VALUES ('13d88743-669e-4d99-8eb0-eee613f5a2c5', 'tenant-c', 'embed', '{"memoryId": "803c4e49-e08f-40ff-bf33-1677351cdde8"}', '2026-09-29 21:19:09.033+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.074+00', NULL, NULL, '2026-09-29 21:19:09.033+00');
INSERT INTO public.outbox VALUES ('4d954172-9431-4658-874b-e03707448acd', 'tenant-c', 'embed', '{"memoryId": "ad31ac07-561f-4ab2-9ac4-f4af9f071447"}', '2026-09-29 21:19:09.036+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.076+00', NULL, NULL, '2026-09-29 21:19:09.036+00');
INSERT INTO public.outbox VALUES ('ef090f42-4824-494b-a318-9259133a60c2', 'tenant-c', 'embed', '{"memoryId": "0896592a-b088-4259-b675-f294ec3f24ae"}', '2026-09-29 21:19:09.039+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.078+00', NULL, NULL, '2026-09-29 21:19:09.039+00');
INSERT INTO public.outbox VALUES ('698c7897-463c-4979-842b-d32704c3e93a', 'tenant-c', 'embed', '{"memoryId": "529fec4e-b51e-4354-81f5-915f551fc090"}', '2026-09-29 21:19:09.042+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.079+00', NULL, NULL, '2026-09-29 21:19:09.042+00');
INSERT INTO public.outbox VALUES ('24ecef67-ca3c-4fdf-9ea2-db8edd35d9f8', 'tenant-c', 'embed', '{"memoryId": "6c7d210c-ea61-4443-97d8-7678c838e050"}', '2026-09-29 21:19:09.045+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.081+00', NULL, NULL, '2026-09-29 21:19:09.045+00');
INSERT INTO public.outbox VALUES ('7a276a2c-eeef-4d46-872b-7c7d73d3d844', 'tenant-c', 'embed', '{"memoryId": "80b4062f-7499-4a58-b4eb-754ec4780413"}', '2026-09-29 21:19:09.048+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.083+00', NULL, NULL, '2026-09-29 21:19:09.048+00');
INSERT INTO public.outbox VALUES ('81a8f336-0727-4a74-a62e-17ca1ada167a', 'tenant-c', 'embed', '{"memoryId": "e1269471-f54e-4110-888a-efba39fde35a"}', '2026-09-29 21:19:09.051+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.085+00', NULL, NULL, '2026-09-29 21:19:09.051+00');
INSERT INTO public.outbox VALUES ('3be22d22-2995-400f-a2d9-10cd1df9d5ac', 'tenant-c', 'embed', '{"memoryId": "50208925-5184-435d-a475-8e89257cbc8c"}', '2026-09-29 21:19:09.055+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.086+00', NULL, NULL, '2026-09-29 21:19:09.055+00');
INSERT INTO public.outbox VALUES ('1988b0b7-8a93-4f54-9e52-9179f8535ea9', 'tenant-c', 'embed', '{"memoryId": "5087e2e0-e935-4722-9c97-ea12083cc089"}', '2026-09-29 21:19:09.058+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.088+00', NULL, NULL, '2026-09-29 21:19:09.058+00');
INSERT INTO public.outbox VALUES ('11ecb9cc-b683-4a89-b5cd-11d524be6b5b', 'tenant-c', 'embed', '{"memoryId": "9116da75-f860-4d17-89a4-2f64e54d8ce6"}', '2026-09-29 21:19:09.061+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.09+00', NULL, NULL, '2026-09-29 21:19:09.061+00');
INSERT INTO public.outbox VALUES ('c2f43b01-35ad-4762-a438-a0cd50ce4fed', 'tenant-c', 'embed', '{"memoryId": "2d300c70-9a57-4349-a006-717b3abfc57c"}', '2026-09-29 21:19:09.064+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.092+00', NULL, NULL, '2026-09-29 21:19:09.064+00');
INSERT INTO public.outbox VALUES ('9c6a0914-ae6c-4be5-9cf6-99a7030b5d2a', 'tenant-c', 'embed', '{"memoryId": "d76c3b7e-2b3c-49b3-8be7-303230c6584a"}', '2026-09-29 21:19:09.067+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, '2026-09-29 21:19:09.093+00', NULL, NULL, '2026-09-29 21:19:09.067+00');
INSERT INTO public.outbox VALUES ('7e7ceeb2-3a1d-4373-8d72-57ced909db13', 'tenant-c', 'embed', '{"memoryId": "1a9e0273-c36f-45ed-89eb-4106208cd32d"}', '2026-09-29 21:19:09.07+00', '2026-09-29 21:19:09.072+00', 'runtime.tick', 1, NULL, '2026-09-29 21:19:09.095+00', 'fixture: embedding provider failure', '2026-09-29 21:19:09.07+00');
INSERT INTO public.outbox VALUES ('99b45755-f0dd-421d-8742-a42fc707061f', 'tenant-c', 'embed', '{"memoryId": "6023da71-4646-4143-8d63-6021c08c06b7"}', '2026-09-29 21:19:09.097+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.097+00');
INSERT INTO public.outbox VALUES ('8dcb32a0-b304-4339-8d2e-eee7e6d50597', 'tenant-c', 'extract', '{"observationId": "ac3a6801-99b0-43fc-acba-3b2fd5dedf2e"}', '2026-09-29 21:19:09.095+00', NULL, NULL, 0, '2026-09-29 21:19:09.098+00', NULL, NULL, '2026-09-29 21:19:09.095+00');
INSERT INTO public.outbox VALUES ('73ae0688-9790-44ce-92db-62cf41c1f5c6', 'tenant-c', 'embed', '{"memoryId": "03c2f3f3-f14c-4b43-8b71-ea306b03de60"}', '2026-09-29 21:19:09.1+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.1+00');
INSERT INTO public.outbox VALUES ('996434a2-4ebf-42ac-838e-04f16cae0ba7', 'tenant-c', 'extract', '{"observationId": "57f33b89-4937-47dc-ab90-21ad5840cbb9"}', '2026-09-29 21:19:09.099+00', NULL, NULL, 0, '2026-09-29 21:19:09.101+00', NULL, NULL, '2026-09-29 21:19:09.099+00');
INSERT INTO public.outbox VALUES ('ae427b84-6e15-410b-80e9-0180e26e07eb', 'tenant-c', 'embed', '{"memoryId": "423c076d-ec57-4c09-baa3-f598d7b15a75"}', '2026-09-29 21:19:09.103+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.103+00');
INSERT INTO public.outbox VALUES ('264442e7-43ac-463e-baeb-247a285dd9f1', 'tenant-c', 'extract', '{"observationId": "10c5dbda-ab9f-473c-ba76-337787c1c29e"}', '2026-09-29 21:19:09.102+00', NULL, NULL, 0, '2026-09-29 21:19:09.104+00', NULL, NULL, '2026-09-29 21:19:09.102+00');
INSERT INTO public.outbox VALUES ('657b45bc-1814-479b-9c15-e0edcaef7063', 'tenant-a2', 'extract', '{"observationId": "22d87971-b16d-40cd-9c9d-ef9b1220512d"}', '2026-09-29 21:19:09.126+00', NULL, NULL, 0, '2026-09-29 21:19:09.129+00', NULL, NULL, '2026-09-29 21:19:09.126+00');
INSERT INTO public.outbox VALUES ('ff8bf423-8919-497d-bc52-983e40fac51e', 'tenant-a2', 'extract', '{"observationId": "be096dd0-5a06-465f-ab87-0ea845b68130"}', '2026-09-29 21:19:09.129+00', NULL, NULL, 0, '2026-09-29 21:19:09.132+00', NULL, NULL, '2026-09-29 21:19:09.129+00');
INSERT INTO public.outbox VALUES ('c7a160ba-8636-4c17-be2e-8654755f6ac0', 'tenant-a2', 'extract', '{"observationId": "538f5b86-ad57-4764-b18d-78c1d876697a"}', '2026-09-29 21:19:09.132+00', NULL, NULL, 0, '2026-09-29 21:19:09.135+00', NULL, NULL, '2026-09-29 21:19:09.132+00');
INSERT INTO public.outbox VALUES ('f5912c19-bc8c-4b26-b723-2b157bb881a7', 'tenant-a2', 'extract', '{"observationId": "288ae0e3-74ca-4be1-bd12-c20ade29adc9"}', '2026-09-29 21:19:09.135+00', NULL, NULL, 0, '2026-09-29 21:19:09.138+00', NULL, NULL, '2026-09-29 21:19:09.135+00');
INSERT INTO public.outbox VALUES ('b1c83151-457b-42df-8be1-51588b0547b2', 'tenant-a2', 'embed', '{"memoryId": "496090f5-d621-4c95-ada9-f7013ab52acc"}', '2026-09-29 21:19:09.127+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.161+00', NULL, NULL, '2026-09-29 21:19:09.127+00');
INSERT INTO public.outbox VALUES ('a88b7cac-1aff-4dae-8347-4aea6def4879', 'tenant-a2', 'extract', '{"observationId": "d6393d8b-3482-4669-860b-59b9cc83e922"}', '2026-09-29 21:19:09.138+00', NULL, NULL, 0, '2026-09-29 21:19:09.141+00', NULL, NULL, '2026-09-29 21:19:09.138+00');
INSERT INTO public.outbox VALUES ('4df3a244-0639-48f3-ae8d-2e4d06a8a9a0', 'tenant-a2', 'extract', '{"observationId": "0dd58802-84bf-4811-a64c-b7be9adeb8c5"}', '2026-09-29 21:19:09.141+00', NULL, NULL, 0, '2026-09-29 21:19:09.144+00', NULL, NULL, '2026-09-29 21:19:09.141+00');
INSERT INTO public.outbox VALUES ('acff5acc-9966-49b7-82f9-265b721eff51', 'tenant-a2', 'extract', '{"observationId": "632f2625-a6f9-4ffe-b9d8-4c01e6ad96c4"}', '2026-09-29 21:19:09.144+00', NULL, NULL, 0, '2026-09-29 21:19:09.147+00', NULL, NULL, '2026-09-29 21:19:09.144+00');
INSERT INTO public.outbox VALUES ('df722cda-a02e-43dc-83ec-121f04880757', 'tenant-a2', 'extract', '{"observationId": "10880072-5972-4e26-9fd7-e27e3dfdd759"}', '2026-09-29 21:19:09.147+00', NULL, NULL, 0, '2026-09-29 21:19:09.15+00', NULL, NULL, '2026-09-29 21:19:09.147+00');
INSERT INTO public.outbox VALUES ('331bdb3b-1f88-41b7-bea8-c9c8a9f5b176', 'tenant-a2', 'extract', '{"observationId": "16fc8e75-9ee5-43bd-9dd3-e75595f71ae6"}', '2026-09-29 21:19:09.151+00', NULL, NULL, 0, '2026-09-29 21:19:09.153+00', NULL, NULL, '2026-09-29 21:19:09.151+00');
INSERT INTO public.outbox VALUES ('f6d88ae2-811e-4c61-a789-9c5977ed49c1', 'tenant-a2', 'extract', '{"observationId": "9c25633b-0a84-40ba-8113-43263ffa210f"}', '2026-09-29 21:19:09.153+00', NULL, NULL, 0, '2026-09-29 21:19:09.156+00', NULL, NULL, '2026-09-29 21:19:09.153+00');
INSERT INTO public.outbox VALUES ('8b0fa823-87ac-41ae-ac9c-0b14cf1a141b', 'tenant-a2', 'extract', '{"observationId": "c60394fd-2f6c-4c4f-b73c-3171617dbab8"}', '2026-09-29 21:19:09.156+00', NULL, NULL, 0, '2026-09-29 21:19:09.159+00', NULL, NULL, '2026-09-29 21:19:09.156+00');
INSERT INTO public.outbox VALUES ('8dae36f6-1fab-4822-9e10-d21aa100c87c', 'tenant-a2', 'embed', '{"memoryId": "6adbf50b-61e7-4b03-a54a-f9c4d2960d73"}', '2026-09-29 21:19:09.13+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.164+00', NULL, NULL, '2026-09-29 21:19:09.13+00');
INSERT INTO public.outbox VALUES ('13a841d6-2be7-449a-9c41-5741c0817631', 'tenant-a2', 'embed', '{"memoryId": "2ea3bcd6-8d52-44b6-84ea-3e1c2d815346"}', '2026-09-29 21:19:09.133+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.166+00', NULL, NULL, '2026-09-29 21:19:09.133+00');
INSERT INTO public.outbox VALUES ('8b5bd5bb-b668-4c0a-9576-d7e54b70bfc0', 'tenant-a2', 'embed', '{"memoryId": "114fa41b-0db7-40c6-a5bf-f70e8d14ce0a"}', '2026-09-29 21:19:09.136+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.168+00', NULL, NULL, '2026-09-29 21:19:09.136+00');
INSERT INTO public.outbox VALUES ('2e743664-b317-46c1-9bfd-71ae2ca76885', 'tenant-a2', 'embed', '{"memoryId": "e2768f28-5722-457e-aadf-7918c1f6af0e"}', '2026-09-29 21:19:09.14+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.17+00', NULL, NULL, '2026-09-29 21:19:09.14+00');
INSERT INTO public.outbox VALUES ('d25269ca-011a-40ff-84d6-c043ebf4fcd1', 'tenant-a2', 'embed', '{"memoryId": "ec8f5a3c-0b36-4080-a8e4-bc7e3d15c5ea"}', '2026-09-29 21:19:09.142+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.171+00', NULL, NULL, '2026-09-29 21:19:09.142+00');
INSERT INTO public.outbox VALUES ('a38ee4e0-6a45-48d1-a5bf-58e2bb0efa3d', 'tenant-a2', 'embed', '{"memoryId": "04049d67-9084-4e11-8721-2e6c76210229"}', '2026-09-29 21:19:09.146+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.173+00', NULL, NULL, '2026-09-29 21:19:09.146+00');
INSERT INTO public.outbox VALUES ('6617ee16-f470-4d78-b280-60c7ca52b463', 'tenant-a2', 'embed', '{"memoryId": "9f24e4e1-0c22-45c0-9f03-b834cf4a5275"}', '2026-09-29 21:19:09.149+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.175+00', NULL, NULL, '2026-09-29 21:19:09.149+00');
INSERT INTO public.outbox VALUES ('22e882ac-d505-4cba-82a2-8192c9a5ee83', 'tenant-a2', 'embed', '{"memoryId": "da9fe5f8-52b7-4d40-8de7-1513742246ec"}', '2026-09-29 21:19:09.152+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.177+00', NULL, NULL, '2026-09-29 21:19:09.152+00');
INSERT INTO public.outbox VALUES ('fa4f69ae-93ef-4c38-ab72-0d0fa2c77840', 'tenant-a2', 'embed', '{"memoryId": "b16c41a7-e0dd-48bf-a5e9-17732265cfb4"}', '2026-09-29 21:19:09.155+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, '2026-09-29 21:19:09.178+00', NULL, NULL, '2026-09-29 21:19:09.155+00');
INSERT INTO public.outbox VALUES ('cb599aa3-849c-42dd-99e6-330370dd280e', 'tenant-a2', 'embed', '{"memoryId": "b4ef02b5-0add-4954-a753-17beef9a4947"}', '2026-09-29 21:19:09.158+00', '2026-09-29 21:19:09.159+00', 'runtime.tick', 1, NULL, '2026-09-29 21:19:09.18+00', 'fixture: embedding provider failure', '2026-09-29 21:19:09.158+00');
INSERT INTO public.outbox VALUES ('997e7dc3-2642-4fdc-9bf4-c87ffa5b4861', 'tenant-a2', 'embed', '{"memoryId": "adf5081f-804e-4f4f-ae6f-19de33396c47"}', '2026-09-29 21:19:09.181+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.181+00');
INSERT INTO public.outbox VALUES ('9d12d92d-b5a1-42e1-bbc9-f2c6dcb821e0', 'tenant-a2', 'extract', '{"observationId": "32cb7fd4-9db9-4344-ad1e-b812e31b4487"}', '2026-09-29 21:19:09.18+00', NULL, NULL, 0, '2026-09-29 21:19:09.183+00', NULL, NULL, '2026-09-29 21:19:09.18+00');
INSERT INTO public.outbox VALUES ('c3cc348a-2117-413f-beea-94f445f96b22', 'tenant-a2', 'embed', '{"memoryId": "f1027e42-06bb-4ba2-82bf-d4949f56d5e9"}', '2026-09-29 21:19:09.185+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.185+00');
INSERT INTO public.outbox VALUES ('b0d56400-07a3-4b87-87e7-b87c26e967bf', 'tenant-a2', 'extract', '{"observationId": "b015484f-449f-4a8c-a3ca-1c2f8f76ee21"}', '2026-09-29 21:19:09.183+00', NULL, NULL, 0, '2026-09-29 21:19:09.186+00', NULL, NULL, '2026-09-29 21:19:09.183+00');
INSERT INTO public.outbox VALUES ('c6580797-5a89-43f2-9c84-bccd468b8364', 'tenant-a2', 'embed', '{"memoryId": "47251278-3368-477b-b190-caefb117fe06"}', '2026-09-29 21:19:09.188+00', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-29 21:19:09.188+00');
INSERT INTO public.outbox VALUES ('ca204f3e-203c-48fd-9bb0-cd55b33416f4', 'tenant-a2', 'extract', '{"observationId": "9deda963-7bce-4907-bb6f-80c07a63a2b6"}', '2026-09-29 21:19:09.186+00', NULL, NULL, 0, '2026-09-29 21:19:09.189+00', NULL, NULL, '2026-09-29 21:19:09.186+00');


--
-- Data for Name: recall_usages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recall_usages VALUES ('tenant-a', 'a0e91c1a-1c9e-49ed-9b5f-932d3d40ae54', 'eceeb8ce-53c8-4f31-bd48-8a58beab0285', '2026-09-29 21:19:08.886429+00');
INSERT INTO public.recall_usages VALUES ('tenant-b', 'd1164ed2-fc34-4b7c-8b8b-aaf0399adc65', '78f77025-74b7-4f26-9f7f-42ee84b9744c', '2026-09-29 21:19:09.028702+00');
INSERT INTO public.recall_usages VALUES ('tenant-c', '9f64d305-fd2a-4ff0-8e75-196b21b58228', '0896592a-b088-4259-b675-f294ec3f24ae', '2026-09-29 21:19:09.123597+00');
INSERT INTO public.recall_usages VALUES ('tenant-a2', 'd61bdf72-c9f6-4d2c-92af-79925ffb3a9e', '2ea3bcd6-8d52-44b6-84ea-3e1c2d815346', '2026-09-29 21:19:09.209575+00');


--
-- Data for Name: recalls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recalls VALUES ('a0e91c1a-1c9e-49ed-9b5f-932d3d40ae54', 'tenant-a', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "ann_truncated", "certainty": "undecidable", "countKind": "unknown", "undecidableReason": "ANN が返した最後の similarity が 0 以下または非有限である（NaN）。この場合、上界の不等式は total の順序を保証しない。"}, {"kind": "over_limit", "count": 2, "stage": "association", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1357, "byTier": {"full": 0, "index": 898, "digest": 459, "association": 286}, "counter": "heuristic", "indexChars": 898, "estimatedTokens": 527}', '{"groups": [{"key": null, "axis": "subject", "count": 24, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a 未埋め込み 2", "memoryId": "f5164112-4633-45d4-9b50-060b98958dd4"}, {"digest": "tenant-a 未埋め込み 1", "memoryId": "c35c9683-2387-4754-8aa2-77f7f9e132bc"}, {"digest": "tenant-a 未埋め込み 0", "memoryId": "65da3405-5041-492f-af51-311727b215f9"}, {"digest": "tenant-a FAIL 埋め込み失敗 東京", "memoryId": "b1bdc4cb-d784-4f00-86b3-b8e4175b797d"}, {"digest": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "9a2bcf9e-4b48-49f9-84b6-30bd672a47da"}, {"digest": "tenant-a の記憶 7 東京 会議 プロジェクト2", "memoryId": "3a1709cc-8637-4bf5-8dee-39dada23cb30"}, {"digest": "tenant-a の記憶 5 東京 会議 プロジェクト0", "memoryId": "db0bc183-c53f-417c-b4c1-025cd7474242"}, {"digest": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "f470586c-8af7-4d6c-895d-3f2884d38869"}], "totalInScope": 24, "digestBandCoverage": {"shown": 8, "eligible": 8, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-29T21:19:08.870Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 20, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 20, "withinLimit": 5, "notComparable": 2, "passedThreshold": 18}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "association", "detail": {"hits": 13, "anchors": 3, "selected": 10}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 15, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 24}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-29 21:19:08.87+00', '{"memories": [{"score": {"decay": 0.9999999727233753, "total": 0.7063611689138942, "strength": 1, "tagMatch": 1, "freshness": 0.9999999727233753, "similarity": 0.7063612074481929, "affinityMeasured": true}, "memoryId": "eceeb8ce-53c8-4f31-bd48-8a58beab0285", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999735256289, "total": 0.7058285157206924, "strength": 1, "tagMatch": 1, "freshness": 0.9999999735256289, "similarity": 0.7058285530934261, "affinityMeasured": true}, "memoryId": "65826ca6-3ea1-409b-877a-cbeb6cc2178c", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999676424354, "total": 0.7057910351334452, "strength": 1, "tagMatch": 1, "freshness": 0.9999999676424354, "similarity": 0.7057910808088055, "affinityMeasured": true}, "memoryId": "8616afb7-77f5-48ef-b83a-8fa785553645", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999641660029, "total": 0.7056453896483151, "strength": 1, "tagMatch": 1, "freshness": 0.9999999641660029, "similarity": 0.7056454402205076, "affinityMeasured": true}, "memoryId": "4ce790df-4e6f-4fe7-aa9e-aa9a89f03ca9", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999745953004, "total": 0.705296251681191, "strength": 1, "tagMatch": 1, "freshness": 0.9999999745953004, "similarity": 0.7052962875168712, "affinityMeasured": true}, "memoryId": "b971cb6f-4f8f-489f-a92e-f4b5399a2b12", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999652356745, "strength": 1, "tagMatch": 1, "freshness": 0.9999999652356745, "affinityMeasured": false}, "memoryId": "ee33db96-defd-4b3b-949b-77a1e65dab86", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.999999975664972, "strength": 1, "tagMatch": 1, "freshness": 0.999999975664972, "affinityMeasured": false}, "memoryId": "22328c13-90e3-44a3-994e-fa03fce4715c", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.9999999665727638, "strength": 1, "tagMatch": 1, "freshness": 0.9999999665727638, "affinityMeasured": false}, "memoryId": "77445d98-551f-4602-89ca-170a70a6a7d8", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.999999968712107, "strength": 1, "tagMatch": 1, "freshness": 0.999999968712107, "affinityMeasured": false}, "memoryId": "fd108a3f-04aa-49a3-ac6d-d59bac1508bc", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.99999997085145, "strength": 1, "tagMatch": 1, "freshness": 0.99999997085145, "affinityMeasured": false}, "memoryId": "18825385-0942-41ff-b004-0dad509b8bf4", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.9999999716537037, "strength": 1, "tagMatch": 1, "freshness": 0.9999999716537037, "affinityMeasured": false}, "memoryId": "37614f7f-d6cb-44b6-a392-d1dba00ae236", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.9999999513299446, "strength": 1, "tagMatch": 1, "freshness": 0.9999999513299446, "affinityMeasured": false}, "memoryId": "897a41c6-5c2d-4f4d-add6-3b099d95114b", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.9999999497254373, "strength": 1, "tagMatch": 1, "freshness": 0.9999999497254373, "affinityMeasured": false}, "memoryId": "a46ec3f5-43bf-4d94-894f-8fb2de2de3f6", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.9999999473186764, "strength": 1, "tagMatch": 1, "freshness": 0.9999999473186764, "affinityMeasured": false}, "memoryId": "e0081a9b-ab0b-4d2e-aace-2fb878388ee3", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.9999999585502273, "strength": 1, "tagMatch": 1, "freshness": 0.9999999585502273, "affinityMeasured": false}, "memoryId": "f74cbb10-2e47-42d6-a35c-10b63088ecd8", "retrievedVia": "association", "associationOf": "eceeb8ce-53c8-4f31-bd48-8a58beab0285"}, {"score": {"decay": 0.9999999564108842, "strength": 1, "tagMatch": 1, "freshness": 0.9999999564108842, "affinityMeasured": false}, "memoryId": "149ba346-7bb5-4479-b380-01b7520b1518", "companionOf": "f74cbb10-2e47-42d6-a35c-10b63088ecd8", "retrievedVia": "mandatory_companion"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('d1164ed2-fc34-4b7c-8b8b-aaf0399adc65', 'tenant-b', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "unit_assembly_dropped", "count": 1, "countKind": "lower_bound"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1091, "byTier": {"full": 0, "index": 806, "digest": 285, "association": 140}, "counter": "heuristic", "indexChars": 806, "estimatedTokens": 400}', '{"groups": [{"key": null, "axis": "subject", "count": 17, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-b 未埋め込み 2", "memoryId": "a6369cc6-0d23-4855-b2b2-9c17bb601ac4"}, {"digest": "tenant-b 未埋め込み 1", "memoryId": "c671fe01-0eb3-4ec6-a4d3-139226e4f756"}, {"digest": "tenant-b 未埋め込み 0", "memoryId": "370a2fd7-0122-4f2c-8067-33b2105b749d"}, {"digest": "tenant-b FAIL 埋め込み失敗 東京", "memoryId": "a557b10f-571d-481a-ab40-f77579405ccc"}, {"digest": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "e5b7d4de-20f6-49f9-9c9f-f8d7b52db74a"}, {"digest": "tenant-b の記憶 6 東京 会議 プロジェクト1", "memoryId": "06e363fc-41f9-423b-84cf-57c3948d536f"}, {"digest": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "40156ace-7cd4-4039-acf9-329df0ab0023"}], "totalInScope": 17, "digestBandCoverage": {"shown": 7, "eligible": 7, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-29T21:19:09.021Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 13, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 13, "withinLimit": 5, "notComparable": 2, "passedThreshold": 11}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "association", "detail": {"hits": 6, "anchors": 3, "selected": 6}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 10, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 17}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-29 21:19:09.021+00', '{"memories": [{"score": {"decay": 0.9999999794088223, "total": 0.6564810147250412, "strength": 1, "tagMatch": 1, "freshness": 0.9999999794088223, "similarity": 0.6564810417604764, "affinityMeasured": true}, "memoryId": "78f77025-74b7-4f26-9f7f-42ee84b9744c", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999783391509, "total": 0.6564712451650592, "strength": 1, "tagMatch": 1, "freshness": 0.9999999783391509, "similarity": 0.6564712736045092, "affinityMeasured": true}, "memoryId": "88672c65-0318-46aa-9979-efb590afe38a", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999772694793, "total": 0.6564612367782746, "strength": 1, "tagMatch": 1, "freshness": 0.9999999772694793, "similarity": 0.6564612666216871, "affinityMeasured": true}, "memoryId": "b653da21-8dd6-4080-82dc-793dab1a8c15", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999812807476, "total": 0.6554165939665478, "strength": 1, "tagMatch": 1, "freshness": 0.9999999812807476, "similarity": 0.6554166185043658, "affinityMeasured": true}, "memoryId": "e2081c0b-cf18-4bbe-9a9c-44ef2a48dabe", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999802110761, "total": 0.6554060787826824, "strength": 1, "tagMatch": 1, "freshness": 0.9999999802110761, "similarity": 0.6554061047222453, "affinityMeasured": true}, "memoryId": "e06b5dcf-dfa0-4051-922c-f17c74d72651", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999652356745, "strength": 1, "tagMatch": 1, "freshness": 0.9999999652356745, "affinityMeasured": false}, "memoryId": "34bc6c50-4daf-455e-93a8-c0810d9af8d2", "retrievedVia": "association", "associationOf": "78f77025-74b7-4f26-9f7f-42ee84b9744c"}, {"score": {"decay": 0.9999999663053459, "strength": 1, "tagMatch": 1, "freshness": 0.9999999663053459, "affinityMeasured": false}, "memoryId": "b2b96f0e-a4b7-4073-9829-a62a14b5a6a8", "retrievedVia": "association", "associationOf": "78f77025-74b7-4f26-9f7f-42ee84b9744c"}, {"score": {"decay": 0.9999999673750175, "strength": 1, "tagMatch": 1, "freshness": 0.9999999673750175, "affinityMeasured": false}, "memoryId": "8ee354d2-7ac4-4c57-9d74-e58d0b8c0a58", "retrievedVia": "association", "associationOf": "78f77025-74b7-4f26-9f7f-42ee84b9744c"}, {"score": {"decay": 0.9999999703166143, "strength": 1, "tagMatch": 1, "freshness": 0.9999999703166143, "affinityMeasured": false}, "memoryId": "006a5c23-3369-4987-a892-6ba3458bbc0f", "retrievedVia": "association", "associationOf": "78f77025-74b7-4f26-9f7f-42ee84b9744c"}, {"score": {"decay": 0.9999999724559573, "strength": 1, "tagMatch": 1, "freshness": 0.9999999724559573, "affinityMeasured": false}, "memoryId": "914f6a5a-33b7-4a76-99bc-822d89a29b7e", "retrievedVia": "association", "associationOf": "78f77025-74b7-4f26-9f7f-42ee84b9744c"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('9f64d305-fd2a-4ff0-8e75-196b21b58228', 'tenant-c', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 784, "byTier": {"full": 0, "index": 616, "digest": 168, "association": 0}, "counter": "heuristic", "indexChars": 616, "estimatedTokens": 272}', '{"groups": [{"key": null, "axis": "subject", "count": 11, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-c 未埋め込み 2", "memoryId": "423c076d-ec57-4c09-baa3-f598d7b15a75"}, {"digest": "tenant-c 未埋め込み 1", "memoryId": "03c2f3f3-f14c-4b43-8b71-ea306b03de60"}, {"digest": "tenant-c 未埋め込み 0", "memoryId": "6023da71-4646-4143-8d63-6021c08c06b7"}, {"digest": "tenant-c FAIL 埋め込み失敗 東京", "memoryId": "1a9e0273-c36f-45ed-89eb-4106208cd32d"}, {"digest": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "529fec4e-b51e-4354-81f5-915f551fc090"}], "totalInScope": 11, "digestBandCoverage": {"shown": 5, "eligible": 5, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-29T21:19:09.117Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 7, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 7, "withinLimit": 5, "notComparable": 1, "passedThreshold": 6}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "association", "detail": {"hits": 0, "anchors": 3, "selected": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 11}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-29 21:19:09.117+00', '{"memories": [{"score": {"decay": 0.9999999791414045, "total": 0.5446699218557371, "strength": 1, "tagMatch": 1, "freshness": 0.9999999791414045, "similarity": 0.5446699445778371, "affinityMeasured": true}, "memoryId": "0896592a-b088-4259-b675-f294ec3f24ae", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999780717329, "total": 0.5442745693634535, "strength": 1, "tagMatch": 1, "freshness": 0.9999999780717329, "similarity": 0.5442745932334506, "affinityMeasured": true}, "memoryId": "ad31ac07-561f-4ab2-9ac4-f4af9f071447", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999839549265, "total": 0.5442011003096203, "strength": 1, "tagMatch": 1, "freshness": 0.9999999839549265, "similarity": 0.544201117773114, "affinityMeasured": true}, "memoryId": "5087e2e0-e935-4722-9c97-ea12083cc089", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999823504192, "strength": 1, "tagMatch": 1, "freshness": 0.9999999823504192, "affinityMeasured": false}, "memoryId": "e1269471-f54e-4110-888a-efba39fde35a", "companionOf": "5087e2e0-e935-4722-9c97-ea12083cc089", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999772694793, "total": 0.5438775823214842, "strength": 1, "tagMatch": 1, "freshness": 0.9999999772694793, "similarity": 0.5438776070467263, "affinityMeasured": true}, "memoryId": "803c4e49-e08f-40ff-bf33-1677351cdde8", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999831526728, "total": 0.5438076665973448, "strength": 1, "tagMatch": 1, "freshness": 0.9999999831526728, "similarity": 0.5438076849207566, "affinityMeasured": true}, "memoryId": "50208925-5184-435d-a475-8e89257cbc8c", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('d61bdf72-c9f6-4d2c-92af-79925ffb3a9e', 'tenant-a2', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 662, "byTier": {"full": 0, "index": 459, "digest": 203, "association": 29}, "counter": "heuristic", "indexChars": 459, "estimatedTokens": 244}', '{"groups": [{"key": null, "axis": "subject", "count": 10, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a2 未埋め込み 2", "memoryId": "47251278-3368-477b-b190-caefb117fe06"}, {"digest": "tenant-a2 FAIL 埋め込み失敗 東京", "memoryId": "b4ef02b5-0add-4954-a753-17beef9a4947"}, {"digest": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "114fa41b-0db7-40c6-a5bf-f70e8d14ce0a"}], "totalInScope": 10, "digestBandCoverage": {"shown": 3, "eligible": 3, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-09-29T21:19:09.200Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 8, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 8, "withinLimit": 5, "notComparable": 1, "passedThreshold": 7}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "association", "detail": {"hits": 1, "anchors": 3, "selected": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 6, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 10}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-29 21:19:09.2+00', '{"memories": [{"score": {"decay": 0.9999999820830012, "total": 0.32964807463882134, "strength": 1, "tagMatch": 1, "freshness": 0.9999999820830012, "similarity": 0.32964808645142996, "affinityMeasured": true}, "memoryId": "2ea3bcd6-8d52-44b6-84ea-3e1c2d815346", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999871639412, "total": 0.3295125279513245, "strength": 1, "tagMatch": 1, "freshness": 0.9999999871639412, "similarity": 0.32951253641060907, "affinityMeasured": true}, "memoryId": "da9fe5f8-52b7-4d40-8de7-1513742246ec", "retrievedVia": "ann"}, {"score": {"decay": 0.999999985292016, "strength": 1, "tagMatch": 1, "freshness": 0.999999985292016, "affinityMeasured": false}, "memoryId": "04049d67-9084-4e11-8721-2e6c76210229", "companionOf": "da9fe5f8-52b7-4d40-8de7-1513742246ec", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999812807476, "total": 0.32920263894658996, "strength": 1, "tagMatch": 1, "freshness": 0.9999999812807476, "similarity": 0.3292026512714449, "affinityMeasured": true}, "memoryId": "6adbf50b-61e7-4b03-a54a-f9c4d2960d73", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999863616875, "total": 0.3290689971157157, "strength": 1, "tagMatch": 1, "freshness": 0.9999999863616875, "similarity": 0.3290690060916075, "affinityMeasured": true}, "memoryId": "9f24e4e1-0c22-45c0-9f03-b834cf4a5275", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999804784939, "total": 0.32875654774429336, "strength": 1, "tagMatch": 1, "freshness": 0.9999999804784939, "similarity": 0.3287565605799396, "affinityMeasured": true}, "memoryId": "496090f5-d621-4c95-ada9-f7013ab52acc", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999844897622, "strength": 1, "tagMatch": 1, "freshness": 0.9999999844897622, "affinityMeasured": false}, "memoryId": "ec8f5a3c-0b36-4080-a8e4-bc7e3d15c5ea", "retrievedVia": "association", "associationOf": "2ea3bcd6-8d52-44b6-84ea-3e1c2d815346"}], "breakdownCaptured": true}');


--
-- Data for Name: tenant_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tenant_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tenant_subject_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: _mnemora_migrations _mnemora_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._mnemora_migrations
    ADD CONSTRAINT _mnemora_migrations_pkey PRIMARY KEY (name);


--
-- Name: labels labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_pkey PRIMARY KEY (id);


--
-- Name: labels labels_tenant_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.labels
    ADD CONSTRAINT labels_tenant_id_name_key UNIQUE (tenant_id, name);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 memory_embeddings_some_very_long_provider_name_an_extr_b34_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257
    ADD CONSTRAINT memory_embeddings_some_very_long_provider_name_an_extr_b34_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_embeddings_test_fixture_model_3 memory_embeddings_test_fixture_model_3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_test_fixture_model_3
    ADD CONSTRAINT memory_embeddings_test_fixture_model_3_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_embeddings_testkit_deterministic_8 memory_embeddings_testkit_deterministic_8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_testkit_deterministic_8
    ADD CONSTRAINT memory_embeddings_testkit_deterministic_8_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_events memory_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_pkey PRIMARY KEY (id);


--
-- Name: memory_labels memory_labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_labels
    ADD CONSTRAINT memory_labels_pkey PRIMARY KEY (tenant_id, memory_id, label_id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: recall_usages recall_usages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_pkey PRIMARY KEY (tenant_id, recall_id, memory_id);


--
-- Name: recalls recalls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_pkey PRIMARY KEY (id);


--
-- Name: tenant_activity tenant_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_activity
    ADD CONSTRAINT tenant_activity_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_settings tenant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_subject_activity tenant_subject_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_subject_activity
    ADD CONSTRAINT tenant_subject_activity_pkey PRIMARY KEY (tenant_id, subject_id);


--
-- Name: idx_labels_by_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_labels_by_status ON public.labels USING btree (tenant_id, status);


--
-- Name: idx_memories_attributes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_attributes ON public.memories USING gin (tenant_id, attributes jsonb_path_ops);


--
-- Name: idx_memories_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_by_subject ON public.memories USING btree (tenant_id, subject_id, status);


--
-- Name: idx_memories_claim_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_claim_key ON public.memories USING btree (tenant_id, subject_id, claim_key_subject, claim_key_predicate) WHERE (claim_key_subject IS NOT NULL);


--
-- Name: idx_memories_contested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested ON public.memories USING btree (tenant_id, status) WHERE (status = 'contested'::text);


--
-- Name: idx_memories_contested_with; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested_with ON public.memories USING btree (contested_with_id) WHERE (contested_with_id IS NOT NULL);


--
-- Name: idx_memories_lexical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_lexical ON public.memories USING gin (tenant_id, public.mnemora_lexical_tsvector(content)) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_period_ann_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_period_ann_stage ON public.memories USING btree (tenant_id, status, COALESCE(occurred_at, recorded_at));


--
-- Name: idx_memories_provenance_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_provenance_kind ON public.memories USING btree (tenant_id, provenance_kind);


--
-- Name: idx_memories_recall_gate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_recall_gate ON public.memories USING btree (tenant_id, status, decay_floor_at) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_recall_gate_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_recall_gate_seq ON public.memories USING btree (tenant_id, status, decay_floor_seq) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_requeue_embed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_requeue_embed ON public.memories USING btree (tenant_id, updated_at, id) WHERE ((status = ANY (ARRAY['active'::text, 'contested'::text])) AND (embedding_status <> 'ready'::text));


--
-- Name: idx_memories_superseded_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_superseded_by ON public.memories USING btree (tenant_id, superseded_by_id) WHERE (superseded_by_id IS NOT NULL);


--
-- Name: idx_memories_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_tags ON public.memories USING gin (tenant_id, tags);


--
-- Name: idx_memory_embeddings_hnsw_some_very_long_provider_nam_0428309b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_some_very_long_provider_nam_0428309b ON public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_hnsw_test_fixture_model_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_test_fixture_model_3 ON public.memory_embeddings_test_fixture_model_3 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_hnsw_testkit_deterministic_8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_testkit_deterministic_8 ON public.memory_embeddings_testkit_deterministic_8 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_zero_norm_some_very_long_provide_0428309b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_zero_norm_some_very_long_provide_0428309b ON public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 USING btree (tenant_id, memory_id) WHERE (public.vector_norm(embedding) = (0)::double precision);


--
-- Name: idx_memory_embeddings_zero_norm_test_fixture_model_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_zero_norm_test_fixture_model_3 ON public.memory_embeddings_test_fixture_model_3 USING btree (tenant_id, memory_id) WHERE (public.vector_norm(embedding) = (0)::double precision);


--
-- Name: idx_memory_embeddings_zero_norm_testkit_deterministic_8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_zero_norm_testkit_deterministic_8 ON public.memory_embeddings_testkit_deterministic_8 USING btree (tenant_id, memory_id) WHERE (public.vector_norm(embedding) = (0)::double precision);


--
-- Name: idx_memory_events_by_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_kind ON public.memory_events USING btree (tenant_id, kind, at);


--
-- Name: idx_memory_events_by_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_memory ON public.memory_events USING btree (tenant_id, memory_id, at);


--
-- Name: idx_memory_events_by_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_retention ON public.memory_events USING btree (tenant_id, at);


--
-- Name: idx_memory_labels_by_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_by_label ON public.memory_labels USING btree (tenant_id, label_id);


--
-- Name: idx_observations_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observations_by_subject ON public.observations USING btree (tenant_id, subject_id, recorded_at);


--
-- Name: idx_outbox_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_claimable ON public.outbox USING btree (tenant_id, available_at) WHERE ((completed_at IS NULL) AND (failed_at IS NULL));


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_pending ON public.outbox USING btree (tenant_id, kind, available_at) WHERE ((completed_at IS NULL) AND (claimed_at IS NULL));


--
-- Name: idx_recalls_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_by_subject ON public.recalls USING btree (tenant_id, subject_id, created_at);


--
-- Name: uq_memories_extraction; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_memories_extraction ON public.memories USING btree (tenant_id, source_observation_id, extractor_version, content_hash) NULLS NOT DISTINCT WHERE (source_observation_id IS NOT NULL);


--
-- Name: uq_observations_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_observations_external_id ON public.observations USING btree (tenant_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: memories memories_contested_with_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_contested_with_id_fkey FOREIGN KEY (contested_with_id) REFERENCES public.memories(id);


--
-- Name: memories memories_source_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_observation_id_fkey FOREIGN KEY (source_observation_id) REFERENCES public.observations(id);


--
-- Name: memories memories_superseded_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_superseded_by_id_fkey FOREIGN KEY (superseded_by_id) REFERENCES public.memories(id);


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 memory_embeddings_some_very_long_provider_name_a_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257
    ADD CONSTRAINT memory_embeddings_some_very_long_provider_name_a_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_embeddings_test_fixture_model_3 memory_embeddings_test_fixture_model_3_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_test_fixture_model_3
    ADD CONSTRAINT memory_embeddings_test_fixture_model_3_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_embeddings_testkit_deterministic_8 memory_embeddings_testkit_deterministic_8_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_testkit_deterministic_8
    ADD CONSTRAINT memory_embeddings_testkit_deterministic_8_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_events memory_events_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: memory_labels memory_labels_label_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_labels
    ADD CONSTRAINT memory_labels_label_id_fkey FOREIGN KEY (label_id) REFERENCES public.labels(id);


--
-- Name: memory_labels memory_labels_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_labels
    ADD CONSTRAINT memory_labels_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: recall_usages recall_usages_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: recall_usages recall_usages_recall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_recall_id_fkey FOREIGN KEY (recall_id) REFERENCES public.recalls(id);


--
-- PostgreSQL database dump complete
--


