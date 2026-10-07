-- 公開済みの版 v1.2.0 で作った DB の fixture（ADR 0344）。
-- ⛔ 手で編集しない。作り直すときは scripts/generate-upgrade-fixture.mjs を走らせる。
--
-- 作ったコード: v1.2.0（d49c46c26748692e9f69f5d0c5729169ef7a1ef3）の @mnemora/postgres / @mnemora/core / @mnemora/testkit。
-- 埋め込み: @mnemora/testkit の DeterministicEmbeddingProvider（外部 API は使っていない）。
-- 中身: すべて合成データ（秘密・個人情報を含まない）。何を入れたかは
--       scripts/generate-upgrade-fixture.mjs の冒頭を見ること。
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-0+deb13u1)
-- Dumped by pg_dump version 17.11 (Debian 17.11-0+deb13u1)

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
-- Name: memory_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    from_memory_id uuid NOT NULL,
    to_memory_id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_relations_kind_check CHECK ((kind = 'contradicts'::text))
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

INSERT INTO public._mnemora_migrations VALUES ('0001_init.sql', '2026-10-07 19:12:49.574031+09');
INSERT INTO public._mnemora_migrations VALUES ('0002_outbox_claim_lease_index.sql', '2026-10-07 19:12:49.58775+09');
INSERT INTO public._mnemora_migrations VALUES ('0003_period_ann_stage_index.sql', '2026-10-07 19:12:49.589019+09');
INSERT INTO public._mnemora_migrations VALUES ('0004_contested_with_index.sql', '2026-10-07 19:12:49.590483+09');
INSERT INTO public._mnemora_migrations VALUES ('0005_analyze_memories.sql', '2026-10-07 19:12:49.59224+09');
INSERT INTO public._mnemora_migrations VALUES ('0006_strength_value_range.sql', '2026-10-07 19:12:49.593905+09');
INSERT INTO public._mnemora_migrations VALUES ('0007_memories_requeue_embed_index.sql', '2026-10-07 19:12:49.595033+09');
INSERT INTO public._mnemora_migrations VALUES ('0008_memories_lexical_index.sql', '2026-10-07 19:12:49.596306+09');
INSERT INTO public._mnemora_migrations VALUES ('0009_memories_lexical_or_coverage.sql', '2026-10-07 19:12:49.59791+09');
INSERT INTO public._mnemora_migrations VALUES ('0010_memory_events_retention_index.sql', '2026-10-07 19:12:49.599318+09');
INSERT INTO public._mnemora_migrations VALUES ('0011_memory_events_kind_restored.sql', '2026-10-07 19:12:49.60037+09');
INSERT INTO public._mnemora_migrations VALUES ('0012_half_life_hours_range.sql', '2026-10-07 19:12:49.60405+09');
INSERT INTO public._mnemora_migrations VALUES ('0013_recall_returned_memories_jsonb.sql', '2026-10-07 19:12:49.606711+09');
INSERT INTO public._mnemora_migrations VALUES ('0014_observations_valid_from_until.sql', '2026-10-07 19:12:49.608084+09');
INSERT INTO public._mnemora_migrations VALUES ('0015_decay_activity_clock.sql', '2026-10-07 19:12:49.608851+09');
INSERT INTO public._mnemora_migrations VALUES ('0016_provenance_kind_matches_provenance.sql', '2026-10-07 19:12:49.613172+09');
INSERT INTO public._mnemora_migrations VALUES ('0017_provenance_kind_matches_provenance_validate.sql', '2026-10-07 19:12:49.614424+09');
INSERT INTO public._mnemora_migrations VALUES ('0018_memory_events_kind_unsuperseded.sql', '2026-10-07 19:12:49.615141+09');
INSERT INTO public._mnemora_migrations VALUES ('0019_observations_memories_attributes.sql', '2026-10-07 19:12:49.616813+09');
INSERT INTO public._mnemora_migrations VALUES ('0020_taxonomy_labels.sql', '2026-10-07 19:12:49.618482+09');
INSERT INTO public._mnemora_migrations VALUES ('0021_memories_claim_key.sql', '2026-10-07 19:12:49.624022+09');
INSERT INTO public._mnemora_migrations VALUES ('0022_embedding_zero_norm_index.sql', '2026-10-07 19:12:49.625444+09');
INSERT INTO public._mnemora_migrations VALUES ('0023_lexical_query_inner_quote_as_space.sql', '2026-10-07 19:12:49.633126+09');
INSERT INTO public._mnemora_migrations VALUES ('0024_tenant_subject_activity.sql', '2026-10-07 19:12:49.634173+09');
INSERT INTO public._mnemora_migrations VALUES ('0025_lexical_tsvector_fallback.sql', '2026-10-07 19:12:49.637573+09');
INSERT INTO public._mnemora_migrations VALUES ('0026_memory_relations.sql', '2026-10-07 19:12:49.640531+09');
INSERT INTO public._mnemora_migrations VALUES ('0027_erase_tenant_fk_indexes.sql', '2026-10-07 19:12:49.649127+09');
INSERT INTO public._mnemora_migrations VALUES ('0028_digest_band_index.sql', '2026-10-07 19:12:49.653883+09');
INSERT INTO public._mnemora_migrations VALUES ('0029_memories_claim_predicates_index.sql', '2026-10-07 19:12:49.6554+09');
INSERT INTO public._mnemora_migrations VALUES ('0030_recalls_digest_band_index.sql', '2026-10-07 19:12:49.656912+09');
INSERT INTO public._mnemora_migrations VALUES ('0031_memory_labels_label_id_index.sql', '2026-10-07 19:12:49.658389+09');
INSERT INTO public._mnemora_migrations VALUES ('0032_purge_indexes.sql', '2026-10-07 19:12:49.659351+09');


--
-- Data for Name: labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memories VALUES ('9da74c9a-e84e-4c92-9403-a9644ddfc4e2', 'tenant-a', NULL, 'dac5d34f-27b5-4774-b69c-a52741f102ca', 'v1', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'ed6b6174b16e829904eb19e37af61bcdac066ad24d037aab65ab91746f903e4e', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.703Z", "kind": "stated", "speaker": "user", "sourceObservationId": "dac5d34f-27b5-4774-b69c-a52741f102ca"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.706+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.327+09', 'ready', NULL, '2026-10-07 19:12:49.707494+09', '2026-10-07 19:12:49.871975+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('30fc99e8-5f10-4be6-8010-b10d910ce337', 'tenant-a', NULL, '1d97b1ed-265d-4058-b69d-896f3400ef77', 'v1', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'd5783633ec67bfa023b1656bde0eda60589e932b2e5eb00bad51d9366c647db5', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.711Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1d97b1ed-265d-4058-b69d-896f3400ef77"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.713+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.334+09', 'ready', NULL, '2026-10-07 19:12:49.713515+09', '2026-10-07 19:12:49.875181+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6125525a-ae5f-4bdf-8cca-a625c29ca568', 'tenant-a', NULL, '03b945b2-3004-4ec2-822d-2087c5a606ac', 'v1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'd6d0bf800f00f3c35af37625f3533767a4db7afbdc77fe18c3bc2d5987ba70c1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.716Z", "kind": "stated", "speaker": "user", "sourceObservationId": "03b945b2-3004-4ec2-822d-2087c5a606ac"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.718+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.339+09', 'ready', NULL, '2026-10-07 19:12:49.719312+09', '2026-10-07 19:12:49.879586+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('94f35c86-e0c2-4754-849c-68bb1d35bcb7', 'tenant-a', NULL, 'ca0c0a6a-8787-448c-acdc-cd7f3454e2eb', 'v1', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'edf34c29245092db70ab98057250239de4f569a113efa424ebda0f9cd882bd55', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.731Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ca0c0a6a-8787-448c-acdc-cd7f3454e2eb"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.734+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.355+09', 'ready', NULL, '2026-10-07 19:12:49.734435+09', '2026-10-07 19:12:49.889841+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d75349ca-82d1-417a-a673-858338419917', 'tenant-a', NULL, '6d1f2115-b891-4b08-b19f-c0f99080b7ee', 'v1', 'tenant-a の記憶 7 東京 会議 プロジェクト2', '0c60f6ec18ba3a28b875b6830e0201a28a0ce0a0831c5c1cfa14d9213f4fccc3', 'tenant-a の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.743Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6d1f2115-b891-4b08-b19f-c0f99080b7ee"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.747+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.368+09', 'ready', NULL, '2026-10-07 19:12:49.747915+09', '2026-10-07 19:12:49.896805+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('95565971-61a9-48d4-8bf0-6146c1b18ab4', 'tenant-a', NULL, 'b923926d-5979-4f0c-908b-8fbc8b4d045f', 'v1', 'tenant-a の記憶 12 東京 会議 プロジェクト2', '1416843979dca4b10e813c98b42e4e64184da19a8246431ca987465bf0319a69', 'tenant-a の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.785Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b923926d-5979-4f0c-908b-8fbc8b4d045f"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.787+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.408+09', 'ready', NULL, '2026-10-07 19:12:49.788196+09', '2026-10-07 19:12:49.914763+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e385d8b3-b308-4c04-906c-e9df8b7efb5b', 'tenant-a', NULL, '2c29aa5b-12ed-4fed-93dc-073814b6be56', 'v1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', '85fa57655dee036fb504dc9e026f2dfe383c1140f5fab5d93ff65f97a76f63c1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.791Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2c29aa5b-12ed-4fed-93dc-073814b6be56"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.793+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.414+09', 'ready', NULL, '2026-10-07 19:12:49.793666+09', '2026-10-07 19:12:49.918301+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8e77776f-9fac-490a-a360-03f046b63b21', 'tenant-a', NULL, '60448c08-b265-48eb-89f6-a329bd2ddd82', 'v1', 'tenant-a の記憶 14 東京 会議 プロジェクト4', '566c00e514039c3cbdde42ca12af98244b4fc1d1fba5c31799c41667ccb84955', 'tenant-a の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.797Z", "kind": "stated", "speaker": "user", "sourceObservationId": "60448c08-b265-48eb-89f6-a329bd2ddd82"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.799+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.42+09', 'ready', NULL, '2026-10-07 19:12:49.800155+09', '2026-10-07 19:12:49.921578+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('45289fa9-c141-49e8-aa27-403947904678', 'tenant-a', NULL, '4ff42bf6-a836-47d1-bddc-22eba530577d', 'v1', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'f0b29bf3fc257d56d53bf3a40509a30894afa7846eb7397ab547ea18a3a29c38', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.803Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4ff42bf6-a836-47d1-bddc-22eba530577d"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.805+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.426+09', 'ready', NULL, '2026-10-07 19:12:49.806323+09', '2026-10-07 19:12:49.925397+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('127c9455-d0f5-4d78-bcc2-ff1fda91b591', 'tenant-a', NULL, '90d5e4f0-7a20-4744-b8e5-5435b5e2c8a4', 'v1', 'tenant-a の記憶 4 東京 会議 プロジェクト4', '2d4011873ef8b25d39bde2a8122f185e9e032a938e8e1020e527a073b0930df3', 'tenant-a の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.724Z", "kind": "stated", "speaker": "user", "sourceObservationId": "90d5e4f0-7a20-4744-b8e5-5435b5e2c8a4"}', 'superseded', '94f35c86-e0c2-4754-849c-68bb1d35bcb7', NULL, '{}', NULL, '2026-10-07 19:12:49.727+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.348+09', 'ready', NULL, '2026-10-07 19:12:49.727931+09', '2026-10-07 19:12:49.990827+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d0cc5de2-ea0c-475c-bb6a-0a89874cbede', 'tenant-a', NULL, '5f1af2a1-5bf8-4e9b-a467-51ea0a572373', 'v1', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'd930b5a8cf81e3b3b32791e8dae3c05994da72ef1265c035dfaf39080ed62dbe', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.737Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5f1af2a1-5bf8-4e9b-a467-51ea0a572373"}', 'contested', NULL, '05371d53-f656-469d-be70-9f30b9ea4c0c', '{}', NULL, '2026-10-07 19:12:49.739+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.36+09', 'ready', NULL, '2026-10-07 19:12:49.739962+09', '2026-10-07 19:12:49.994224+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('16eadbc1-1bf8-4efa-8a2f-a64d0d567134', 'tenant-a', NULL, 'cb13c0ff-5e59-4417-b044-e07bf66b005e', 'v1', 'tenant-a の記憶 9 東京 会議 プロジェクト4', '4c241e9f2abb28b016af405d09bb673284fc201c4fac4a039faba6f8c7e22fc3', 'tenant-a の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.764Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cb13c0ff-5e59-4417-b044-e07bf66b005e"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.766+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.387+09', 'ready', NULL, '2026-10-07 19:12:49.767177+09', '2026-10-07 19:12:49.999159+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d9549aaa-52dd-473d-b1b9-05b29f1f821b', 'tenant-a', NULL, '9da33a21-616e-418f-9bb2-9073ed702339', 'v1', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'f43c8e3670dc49dcd5e7d3d4067e6675ad27bf370e403c97f646b08db859894f', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.771Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9da33a21-616e-418f-9bb2-9073ed702339"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.773+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.394+09', 'ready', NULL, '2026-10-07 19:12:49.7744+09', '2026-10-07 19:12:50.001881+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c60f211d-5c6f-4945-8a2d-dac179267962', 'tenant-a', NULL, '7dec288f-9ddc-4555-8903-1915bd4facf6', 'v1', '[purged]', '8baacaa745d740261839f6dbe908954009bba75aead9ea0901933a52379e09f4', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.778Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7dec288f-9ddc-4555-8903-1915bd4facf6"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.78+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.401+09', 'ready', '2026-10-07 19:12:50.012+09', '2026-10-07 19:12:49.781711+09', '2026-10-07 19:12:50.013068+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('32b68e43-7607-43ce-968b-0b780cfe4245', 'tenant-a', NULL, 'f2bd800e-ae1d-4142-8a33-90d6d0d5fb5b', 'v1', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'd3ea19d3736314cb9c467c1662164327f232b7f4614ea76f675772f69c277594', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.686Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f2bd800e-ae1d-4142-8a33-90d6d0d5fb5b"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.693+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.314+09', 'ready', NULL, '2026-10-07 19:12:49.694863+09', '2026-10-07 19:12:49.86854+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8dc7ffd1-b4c8-4396-944e-cc8905b390f2', 'tenant-a', NULL, '9abda3c3-8a4b-4add-8cec-e2c8e600466b', 'v1', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'ca52ff79646f23e88b31f2cd9bab84db866daa8ee904c6ffc4f2608348e05082', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.809Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9abda3c3-8a4b-4add-8cec-e2c8e600466b"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.811+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.432+09', 'ready', NULL, '2026-10-07 19:12:49.812277+09', '2026-10-07 19:12:49.928354+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('96b496be-f3f0-4cea-aaa4-6ca6469d2514', 'tenant-a', NULL, '86c53a97-ffa0-4c99-9370-93bac1c93e88', 'v1', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'b143762528afffbb72a33fb24f70ebd4d19cd0cc89719dd7231a45971896fde7', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.815Z", "kind": "stated", "speaker": "user", "sourceObservationId": "86c53a97-ffa0-4c99-9370-93bac1c93e88"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.817+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.438+09', 'ready', NULL, '2026-10-07 19:12:49.817417+09', '2026-10-07 19:12:49.931072+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('d83a8a10-71ac-47f7-98cd-866c2109058f', 'tenant-a', NULL, 'dafa8d14-afaa-483e-989a-bb426bfb34c0', 'v1', 'tenant-a の記憶 18 東京 会議 プロジェクト3', '6d3a158a624537a869f95ca05e650119d80bbe0cd4f796b22bc3c31ea83ada8a', 'tenant-a の記憶 18 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.820Z", "kind": "stated", "speaker": "user", "sourceObservationId": "dafa8d14-afaa-483e-989a-bb426bfb34c0"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.822+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.443+09', 'ready', NULL, '2026-10-07 19:12:49.822955+09', '2026-10-07 19:12:49.933875+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c32a3934-086f-4808-b9f8-bf1d05d13413', 'tenant-a', NULL, '753c6226-0436-4ac9-9792-c2380330b295', 'v1', 'tenant-a の記憶 19 東京 会議 プロジェクト4', '83b96ac18e746f06f8c77902fd8d7e7f3c59541caaa6ae2658298580ec04e043', 'tenant-a の記憶 19 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.826Z", "kind": "stated", "speaker": "user", "sourceObservationId": "753c6226-0436-4ac9-9792-c2380330b295"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.828+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.449+09', 'ready', NULL, '2026-10-07 19:12:49.828539+09', '2026-10-07 19:12:49.93683+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c60d04c8-7f18-40ac-b425-117dcad2b9c4', 'tenant-a', NULL, '54069544-b88c-4a20-b8f9-3079df03663a', 'v1', 'tenant-a の記憶 21 東京 会議 プロジェクト1', '4c3e66f819f467c96c28794801e751d2d4f6a9e3cd240dcfc9c3bf55c1cacc57', 'tenant-a の記憶 21 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.837Z", "kind": "stated", "speaker": "user", "sourceObservationId": "54069544-b88c-4a20-b8f9-3079df03663a"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.839+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.46+09', 'ready', NULL, '2026-10-07 19:12:49.839758+09', '2026-10-07 19:12:49.946004+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('165a96af-6587-4299-a87a-b08c581ccf0c', 'tenant-a', NULL, '134c45fd-6b42-4bd1-910e-74023fc45912', 'v1', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'b72c9757075adda4486522b26365dfd82a6af69336a4c8f52d4771450c4ce0af', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.843Z", "kind": "stated", "speaker": "user", "sourceObservationId": "134c45fd-6b42-4bd1-910e-74023fc45912"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.847+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.468+09', 'ready', NULL, '2026-10-07 19:12:49.848185+09', '2026-10-07 19:12:49.95117+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1031045a-5312-41df-aa4f-cbeb244c9676', 'tenant-a', NULL, 'b5107091-31f8-4a6c-b62d-af7da5d02e56', 'v1', 'tenant-a の記憶 23 東京 会議 プロジェクト3', '26d0049fe3cf7614c786a48dd795226413a4f6260e020ea8356d457c6ff1ca3f', 'tenant-a の記憶 23 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.852Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b5107091-31f8-4a6c-b62d-af7da5d02e56"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.854+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.475+09', 'ready', NULL, '2026-10-07 19:12:49.854501+09', '2026-10-07 19:12:49.955237+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ca48985b-a8be-472d-b44d-66f9f27d7427', 'tenant-a', NULL, '7f6c3d77-33c2-4c43-b620-578e18912b20', 'v1', 'tenant-a FAIL 埋め込み失敗 東京', 'ab1702dac85d2545c823794fc8106c348a2783463f2ac321911b7721adc9a696', 'tenant-a FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.858Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7f6c3d77-33c2-4c43-b620-578e18912b20"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.859+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.48+09', 'failed', NULL, '2026-10-07 19:12:49.860081+09', '2026-10-07 19:12:49.962196+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f56e4e56-18b6-4be9-8635-66f70bf99079', 'tenant-a', NULL, '0655d0e4-5d79-41ba-9465-b97319b9d042', 'v1', 'tenant-a 未埋め込み 0', '756d0ee3ef05fe980db2aa5224ed49ab257c9c10a80d33a77df32294e4a9b497', 'tenant-a 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.967Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0655d0e4-5d79-41ba-9465-b97319b9d042"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.969+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.59+09', 'pending', NULL, '2026-10-07 19:12:49.96936+09', '2026-10-07 19:12:49.96936+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f113ce19-c359-4019-821e-36a0783e9a4b', 'tenant-a', NULL, '9d404363-788e-4264-9a7e-81c2bf2467f7', 'v1', 'tenant-a 未埋め込み 1', '7a1a046d3656ac2ae59f0f95d457c9c60be31eb915f2dd5cdc53822faaefdf48', 'tenant-a 未埋め込み 1', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.977Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9d404363-788e-4264-9a7e-81c2bf2467f7"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.979+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.6+09', 'pending', NULL, '2026-10-07 19:12:49.979575+09', '2026-10-07 19:12:49.979575+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f0e54766-eb5b-4750-a41b-e686eeaf8a26', 'tenant-a', NULL, '0b36b7d3-04d0-4e9c-bc51-003718185601', 'v1', 'tenant-a 未埋め込み 2', '899e3558b907c6a4074d675812af26d32f5a4d665344080e52cfed3d3c1218f6', 'tenant-a 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.982Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0b36b7d3-04d0-4e9c-bc51-003718185601"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.984+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.605+09', 'skipped', NULL, '2026-10-07 19:12:49.985158+09', '2026-10-07 19:12:49.989031+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('05371d53-f656-469d-be70-9f30b9ea4c0c', 'tenant-a', NULL, '05b46abb-f32c-448f-8377-a1772ecca1e0', 'v1', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'b80d062281da38b404565ed86841de51799a3a0b5a8332e8ae6c080d35716009', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.753Z", "kind": "stated", "speaker": "user", "sourceObservationId": "05b46abb-f32c-448f-8377-a1772ecca1e0"}', 'contested', NULL, 'd0cc5de2-ea0c-475c-bb6a-0a89874cbede', '{}', NULL, '2026-10-07 19:12:49.755+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.376+09', 'ready', NULL, '2026-10-07 19:12:49.756735+09', '2026-10-07 19:12:49.994224+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3c6587dd-bed0-4a33-a929-cef895bcc1c2', 'tenant-a', NULL, 'fa90f474-0d99-43a0-9567-db3c096ab749', 'v1', 'tenant-a の記憶 20 東京 会議 プロジェクト0', '30b8312facf5b4d080051518335646cf1b0811d3dd74936bb276b5f511c2fda4', 'tenant-a の記憶 20 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:49.831Z", "kind": "stated", "speaker": "user", "sourceObservationId": "fa90f474-0d99-43a0-9567-db3c096ab749"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:49.833+09', '2026-10-07 19:12:50.051+09', NULL, NULL, 1, 720, '2027-02-14 11:00:07.672+09', 'ready', NULL, '2026-10-07 19:12:49.833855+09', '2026-10-07 19:12:50.052611+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('0ec8e879-c4d6-448c-9751-1857aec8159e', 'tenant-b', NULL, 'e4d4e135-8244-4842-9612-80c15733c9a8', 'v1', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'b95da75a3bc21f8d9d823c4d001c8086e008dcc6b38e31d6ed7199e9b758b564', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.064Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e4d4e135-8244-4842-9612-80c15733c9a8"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.066+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.687+09', 'ready', NULL, '2026-10-07 19:12:50.067174+09', '2026-10-07 19:12:50.197805+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e8d5424f-0a9a-451e-9f14-77d672705c70', 'tenant-b', NULL, '700eee08-7d19-4b94-842f-ae4a5e65172b', 'v1', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'fef0437ad217559ad5fb73795ca3cec2b335060d36ad7ba7a9da30c623a8f0d3', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.071Z", "kind": "stated", "speaker": "user", "sourceObservationId": "700eee08-7d19-4b94-842f-ae4a5e65172b"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.073+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.694+09', 'ready', NULL, '2026-10-07 19:12:50.073678+09', '2026-10-07 19:12:50.201406+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('263bb4c9-6752-4889-ae08-5a96e72c4902', 'tenant-b', NULL, '384999c2-aec2-40a2-87e9-0193d4ff3d80', 'v1', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', '4e273dcb447fab0d9f4acfd5e8288bf45f0c7eb77b08b9cc0534c25d49c0c4f8', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.076Z", "kind": "stated", "speaker": "user", "sourceObservationId": "384999c2-aec2-40a2-87e9-0193d4ff3d80"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.078+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.699+09', 'ready', NULL, '2026-10-07 19:12:50.078776+09', '2026-10-07 19:12:50.21197+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5cab23bf-8349-4f08-82c4-fcc05b183999', 'tenant-b', NULL, 'fa148901-c42b-487f-a30c-b697500af4e6', 'v1', 'tenant-b の記憶 5 東京 会議 プロジェクト0', '1d9b410d61390a28c636568bbffd238b4e1012db936d587ca2fb4c25642981e9', 'tenant-b の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.089Z", "kind": "stated", "speaker": "user", "sourceObservationId": "fa148901-c42b-487f-a30c-b697500af4e6"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.091+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.712+09', 'ready', NULL, '2026-10-07 19:12:50.092156+09', '2026-10-07 19:12:50.23271+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('9b1fa9a7-1d68-4d06-82b7-029b5e425d28', 'tenant-b', NULL, '1f865044-7d5e-4722-bd18-58feb9b30523', 'v1', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'f1d4ed789aa4b33b86f74868c1d9f1efbac874dbb3cbbdd89a13eabcd6826704', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.103Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1f865044-7d5e-4722-bd18-58feb9b30523"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.105+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.726+09', 'ready', NULL, '2026-10-07 19:12:50.105944+09', '2026-10-07 19:12:50.256891+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b01b630d-8c27-43b0-934a-759588d7f954', 'tenant-b', NULL, 'b7a63156-f81c-48d9-83e4-351e056bc938', 'v1', 'tenant-b の記憶 12 東京 会議 プロジェクト2', '7b361a170b64a9b41f97d624b8bc1cb0f2c68950bfea639ccb5a23c4344575f8', 'tenant-b の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.127Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b7a63156-f81c-48d9-83e4-351e056bc938"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.128+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.749+09', 'ready', NULL, '2026-10-07 19:12:50.128938+09', '2026-10-07 19:12:50.274147+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('453b883d-1d64-4397-b6bd-f9b42c4d9a52', 'tenant-b', NULL, '86ca5159-500b-484c-b1d0-5076b69a1133', 'v1', 'tenant-b の記憶 13 東京 会議 プロジェクト3', '0dc090582bdaf2135130a122f6f926027aa9346166b076aa7ce9d878071c18f3', 'tenant-b の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.131Z", "kind": "stated", "speaker": "user", "sourceObservationId": "86ca5159-500b-484c-b1d0-5076b69a1133"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.133+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.754+09', 'ready', NULL, '2026-10-07 19:12:50.133304+09', '2026-10-07 19:12:50.276942+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('fc49847e-02c0-4b33-a5fb-f4cb7bd4ebb5', 'tenant-b', NULL, '6d0a052c-12b8-4d0e-93bf-b414bf92a753', 'v1', 'tenant-b の記憶 15 東京 会議 プロジェクト0', '159e45fbd8a5ffaff4ae601883d4d60fd353ceca26759a1642630065cef3b241', 'tenant-b の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.142Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6d0a052c-12b8-4d0e-93bf-b414bf92a753"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.144+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.765+09', 'ready', NULL, '2026-10-07 19:12:50.145043+09', '2026-10-07 19:12:50.282625+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ecdef4b9-eb0c-41db-8c13-da58f544686a', 'tenant-b', NULL, '9071431d-f893-4ebc-840f-07f2458c560d', 'v1', 'tenant-b の記憶 4 東京 会議 プロジェクト4', '5940641d2d369c2cc336a4e7e0dfe324af8bd43c6c6bb540111ea25536b9f590', 'tenant-b の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.081Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9071431d-f893-4ebc-840f-07f2458c560d"}', 'superseded', '5cab23bf-8349-4f08-82c4-fcc05b183999', NULL, '{}', NULL, '2026-10-07 19:12:50.083+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.704+09', 'ready', NULL, '2026-10-07 19:12:50.084372+09', '2026-10-07 19:12:50.337418+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('84d27a31-017c-4d50-b5b2-23a5bfb747c1', 'tenant-b', NULL, '57ee7bf1-8d9c-464d-9a41-3c4a9af16503', 'v1', 'tenant-b の記憶 6 東京 会議 プロジェクト1', '25dbc01aa826c3caa1c214b61d630f769615fc5a4f74f62be2b71c2a659e3fa8', 'tenant-b の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.095Z", "kind": "stated", "speaker": "user", "sourceObservationId": "57ee7bf1-8d9c-464d-9a41-3c4a9af16503"}', 'contested', NULL, 'e75d25a6-e93e-4982-af68-f44c408aa00e', '{}', NULL, '2026-10-07 19:12:50.097+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.718+09', 'ready', NULL, '2026-10-07 19:12:50.098309+09', '2026-10-07 19:12:50.339589+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2904e9a5-cd88-4985-b9b9-95798047b0c3', 'tenant-b', NULL, '87f3be43-77d7-4421-9944-d968e75e3a5f', 'v1', 'tenant-b の記憶 9 東京 会議 プロジェクト4', '1e67543f28e3ecb46017a56947f528295cfd849f37bbff911216c8f13f03cb45', 'tenant-b の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.114Z", "kind": "stated", "speaker": "user", "sourceObservationId": "87f3be43-77d7-4421-9944-d968e75e3a5f"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.115+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.736+09', 'ready', NULL, '2026-10-07 19:12:50.11596+09', '2026-10-07 19:12:50.344142+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ac6d95fd-7cb6-4f01-b633-9a5bc2bf5e05', 'tenant-b', NULL, 'b4815f90-b361-49de-a947-a8192d20e60e', 'v1', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'e3ce75d1b42cf68db24819b6cf5a26b4168b236f492bda9ec4f44f99baf6e59f', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.118Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b4815f90-b361-49de-a947-a8192d20e60e"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.119+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.74+09', 'ready', NULL, '2026-10-07 19:12:50.120248+09', '2026-10-07 19:12:50.346046+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5bf76290-e5e2-4fa4-bd2f-2737ef5578c8', 'tenant-b', NULL, 'da4cf9f6-8876-4019-8c8e-e631ffedfa30', 'v1', '[purged]', '624794e8e55d99b8d71021f048790ff041d1bfb438372d59bcdfa91e5e3b0bcd', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.122Z", "kind": "stated", "speaker": "user", "sourceObservationId": "da4cf9f6-8876-4019-8c8e-e631ffedfa30"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.124+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.745+09', 'ready', '2026-10-07 19:12:50.355+09', '2026-10-07 19:12:50.124619+09', '2026-10-07 19:12:50.3561+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6233d0ba-3289-4b18-bf47-3ad3afd3c613', 'tenant-b', NULL, '1f53c121-022c-4a25-96ac-fd59e6c8fd20', 'v1', 'tenant-b の記憶 14 東京 会議 プロジェクト4', '8a607cfc5964eaf69142f32afe35b75600e27d38176864ada321967ce349bc64', 'tenant-b の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.137Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1f53c121-022c-4a25-96ac-fd59e6c8fd20"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.138+09', '2026-10-07 19:12:50.377+09', NULL, NULL, 1, 720, '2027-02-14 11:00:07.998+09', 'ready', NULL, '2026-10-07 19:12:50.13941+09', '2026-10-07 19:12:50.378274+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3f2ddb6d-3ebb-4f2c-b820-967569432b05', 'tenant-b', NULL, '41a79a3b-3a5c-4f9e-8c57-3609e7b5d956', 'v1', 'tenant-b の記憶 0 東京 会議 プロジェクト0', '081a9a9f113b084d0ccebeb4e29f753910bca11b2e4e20168eca50413e85a174', 'tenant-b の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.058Z", "kind": "stated", "speaker": "user", "sourceObservationId": "41a79a3b-3a5c-4f9e-8c57-3609e7b5d956"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.06+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.681+09', 'ready', NULL, '2026-10-07 19:12:50.060635+09', '2026-10-07 19:12:50.192338+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e5987c84-2225-4e1c-8df0-59615e473121', 'tenant-b', NULL, '1a84ab64-d393-4c5a-adba-128c463e7473', 'v1', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'b8c54c018860dad1bd5d84c2883f7deef7dba67a41562560b7454f3565547826', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.157Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1a84ab64-d393-4c5a-adba-128c463e7473"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.17+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.791+09', 'ready', NULL, '2026-10-07 19:12:50.171526+09', '2026-10-07 19:12:50.285656+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('cd3efb23-07cb-490c-89d3-23195c957396', 'tenant-b', NULL, 'd7b83ff4-5468-41b8-80bb-eb60914e1c6c', 'v1', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', '512794d1b4203897a59658ba1c10d0d4ff10f5d69627a6dffa186e0a86c02feb', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.175Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d7b83ff4-5468-41b8-80bb-eb60914e1c6c"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.177+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.798+09', 'ready', NULL, '2026-10-07 19:12:50.178657+09', '2026-10-07 19:12:50.294966+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('60f0fac6-c743-4f0e-9a42-608e8c215244', 'tenant-b', NULL, '7a20e5aa-b947-4a07-af13-25b2c7ab7300', 'v1', 'tenant-b FAIL 埋め込み失敗 東京', 'dca6507a3912ad169580cf2764c29ddf080a9cbf73c32d7ddf16429d985d35ef', 'tenant-b FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.182Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7a20e5aa-b947-4a07-af13-25b2c7ab7300"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.184+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.805+09', 'failed', NULL, '2026-10-07 19:12:50.184675+09', '2026-10-07 19:12:50.304111+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b18db25c-08c7-4b7a-9646-95621eab1b91', 'tenant-b', NULL, '30d5c5c9-0d8f-4aef-8370-eafc26b9d325', 'v1', 'tenant-b 未埋め込み 0', '4f033a8ab5dff18cce4bfac1ffa04151f80b45e51806b9cebeca92a143ae6386', 'tenant-b 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.309Z", "kind": "stated", "speaker": "user", "sourceObservationId": "30d5c5c9-0d8f-4aef-8370-eafc26b9d325"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.311+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.932+09', 'pending', NULL, '2026-10-07 19:12:50.312148+09', '2026-10-07 19:12:50.312148+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8cae5ddc-4556-4e30-8110-48b3c11fcca8', 'tenant-b', NULL, 'cb557362-bcdc-4808-809c-258a4d240831', 'v1', 'tenant-b 未埋め込み 1', '9d77f4b53475fe24e31aaa3bcdc02aa1a0786c37888dcee783f146c4aae191e2', 'tenant-b 未埋め込み 1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.319Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cb557362-bcdc-4808-809c-258a4d240831"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.325+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.946+09', 'pending', NULL, '2026-10-07 19:12:50.326012+09', '2026-10-07 19:12:50.326012+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('b347bac9-0041-4d10-8a6c-10f4e9c75ebc', 'tenant-b', NULL, 'd56da5ee-384a-4119-8805-dcc456b33cc3', 'v1', 'tenant-b 未埋め込み 2', '318fb30d6dda58f1c972e4779c59979fbd926637878da937d6155ac62a286d02', 'tenant-b 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.330Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d56da5ee-384a-4119-8805-dcc456b33cc3"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.332+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.953+09', 'skipped', NULL, '2026-10-07 19:12:50.332429+09', '2026-10-07 19:12:50.33625+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e75d25a6-e93e-4982-af68-f44c408aa00e', 'tenant-b', NULL, '3efd4a19-d1a2-43db-b154-c9236dc62928', 'v1', 'tenant-b の記憶 8 東京 会議 プロジェクト3', '03f24fe74d5d2e3d56878e412d3b0daf983f57c46d18f1bf25917b76cf7ef9f6', 'tenant-b の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.109Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3efd4a19-d1a2-43db-b154-c9236dc62928"}', 'forgotten', NULL, '84d27a31-017c-4d50-b5b2-23a5bfb747c1', '{}', NULL, '2026-10-07 19:12:50.11+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:07.731+09', 'ready', NULL, '2026-10-07 19:12:50.111297+09', '2026-10-07 19:12:50.362845+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a99765fb-053f-4be4-ae02-213c695e85ec', 'tenant-c', NULL, 'e58eb51c-71af-4c5c-b4fb-f1592d668364', 'v1', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'f97a8b4d6e8a9c4b9cc08f892895a26c5150d4dc14b0da37a299e97b759312b2', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.388Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e58eb51c-71af-4c5c-b4fb-f1592d668364"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.389+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.01+09', 'ready', NULL, '2026-10-07 19:12:50.390222+09', '2026-10-07 19:12:50.473762+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('36b1914c-9a39-49c8-a1ca-0e7d9aba6101', 'tenant-c', NULL, '2e18df03-570a-45f3-a4ed-f30d97a31389', 'v1', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', '94612eb1b4f64fa932a1d3db6feb48231cb950d9ffd00939776db4cf1eb29c26', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.399Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2e18df03-570a-45f3-a4ed-f30d97a31389"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.401+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.022+09', 'ready', NULL, '2026-10-07 19:12:50.401462+09', '2026-10-07 19:12:50.480297+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('3fd82bd2-eb5c-4ef0-b063-859fd53c4924', 'tenant-c', NULL, '76799240-dfd8-4ed7-a7c7-d519bca90498', 'v1', 'tenant-c の記憶 7 東京 会議 プロジェクト2', '8c524a04f68127aef3b7b341e63ac27629ee3136f0ef9da63934e27c206cb419', 'tenant-c の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.421Z", "kind": "stated", "speaker": "user", "sourceObservationId": "76799240-dfd8-4ed7-a7c7-d519bca90498"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.423+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.044+09', 'ready', NULL, '2026-10-07 19:12:50.423955+09', '2026-10-07 19:12:50.493501+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('6804edb4-8c73-4b01-8f9b-cfde9abe14cc', 'tenant-c', NULL, '8f17ac01-21c0-49d8-a42c-4bc16c7a8f6b', 'v1', 'tenant-c の記憶 4 東京 会議 プロジェクト4', '81f4ee70cb39ef24184d9447f8e119462e2b333831286169f12207dd00f50327', 'tenant-c の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.405Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8f17ac01-21c0-49d8-a42c-4bc16c7a8f6b"}', 'superseded', '514f505c-2984-4887-ad28-bf84d58a22b2', NULL, '{}', NULL, '2026-10-07 19:12:50.407+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.028+09', 'ready', NULL, '2026-10-07 19:12:50.407756+09', '2026-10-07 19:12:50.59334+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('5288b42a-c6a1-43ed-8586-d61148b7b554', 'tenant-c', NULL, '14907a9d-bd37-4dc3-a51d-889192854951', 'v1', 'tenant-c の記憶 6 東京 会議 プロジェクト1', '1349732c0ebd9031ddc9bcae41973c5c6b6ab2f76e2179b5374ad6957af1fe87', 'tenant-c の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.416Z", "kind": "stated", "speaker": "user", "sourceObservationId": "14907a9d-bd37-4dc3-a51d-889192854951"}', 'contested', NULL, '294f74c8-caf3-43f9-b986-3b9fc00620ca', '{}', NULL, '2026-10-07 19:12:50.417+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.038+09', 'ready', NULL, '2026-10-07 19:12:50.418422+09', '2026-10-07 19:12:50.595217+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('514f505c-2984-4887-ad28-bf84d58a22b2', 'tenant-c', NULL, 'e4d3b447-6ec9-4e4e-951c-a316592bf919', 'v1', 'tenant-c の記憶 5 東京 会議 プロジェクト0', '0996fea87104119898e02a0d9962c82a2dfe8c52e32205dc818277bcf516daf6', 'tenant-c の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.410Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e4d3b447-6ec9-4e4e-951c-a316592bf919"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.412+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.033+09', 'ready', NULL, '2026-10-07 19:12:50.413132+09', '2026-10-07 19:12:50.610606+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('953ed106-e95f-4366-8e11-65e7c7850739', 'tenant-c', NULL, 'ff38eb67-753f-43ba-91cb-63faca683dcb', 'v1', 'tenant-c の記憶 2 東京 会議 プロジェクト2', '2576291adf7ad31335c6494eb95a197053599c859b1067bc5f6b08c63fbd8fc2', 'tenant-c の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.394Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ff38eb67-753f-43ba-91cb-63faca683dcb"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.396+09', '2026-10-07 19:12:50.628+09', NULL, NULL, 1, 720, '2027-02-14 11:00:08.249+09', 'ready', NULL, '2026-10-07 19:12:50.396434+09', '2026-10-07 19:12:50.629164+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('87b0af80-4a09-483a-8937-d7a8299cf069', 'tenant-c', NULL, '1ae14a1c-e686-4b53-a5d5-f4f1b5d3d77e', 'v1', 'tenant-c の記憶 0 東京 会議 プロジェクト0', '0d78da8c6a4e2de262064e70959180f45578ab348746afc04814736d3ec98420', 'tenant-c の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.381Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1ae14a1c-e686-4b53-a5d5-f4f1b5d3d77e"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.383+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.004+09', 'ready', NULL, '2026-10-07 19:12:50.384419+09', '2026-10-07 19:12:50.470281+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c1e8190f-a6d8-4534-bcfd-318832da049a', 'tenant-c', NULL, '554085f8-e701-4e54-8cd4-e2fb1a646b71', 'v1', 'tenant-c FAIL 埋め込み失敗 東京', '985f97e69b2fc62b500ebd50803bce5a72393d80852f55d01d88a21002fd7746', 'tenant-c FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.458Z", "kind": "stated", "speaker": "user", "sourceObservationId": "554085f8-e701-4e54-8cd4-e2fb1a646b71"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.46+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.081+09', 'failed', NULL, '2026-10-07 19:12:50.460973+09', '2026-10-07 19:12:50.518803+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7feac528-333d-4360-85af-c2e8303b98fb', 'tenant-c', NULL, 'c4727d49-6035-4046-9f31-05f9bc6df1b1', 'v1', 'tenant-c 未埋め込み 0', 'dbbed7a9da3bc87703ee74ec7fcbae128292a28245a094e1e7fe55b2e761766d', 'tenant-c 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.523Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c4727d49-6035-4046-9f31-05f9bc6df1b1"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.528+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.149+09', 'pending', NULL, '2026-10-07 19:12:50.533508+09', '2026-10-07 19:12:50.533508+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('790e574d-8baa-4bca-92a4-bbaf44becc82', 'tenant-c', NULL, 'c2b3c5ae-db60-400f-84c3-9a67188036d4', 'v1', 'tenant-c 未埋め込み 1', '6fef40b085316dc1f9517118e7701e59fddc1231ce2b4b7b03aaf45936697d74', 'tenant-c 未埋め込み 1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.579Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c2b3c5ae-db60-400f-84c3-9a67188036d4"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.581+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.202+09', 'pending', NULL, '2026-10-07 19:12:50.581897+09', '2026-10-07 19:12:50.581897+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('2117a8ae-5aac-450b-b430-7597276db1a2', 'tenant-c', NULL, 'e274142b-404d-4be4-a9c1-7694651a7d94', 'v1', 'tenant-c 未埋め込み 2', 'd4169a93c46303e6cc20af167d50c6ffb9c86896911949620cd36e561554b6c1', 'tenant-c 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.585Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e274142b-404d-4be4-a9c1-7694651a7d94"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.587+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.208+09', 'skipped', NULL, '2026-10-07 19:12:50.588106+09', '2026-10-07 19:12:50.591463+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('294f74c8-caf3-43f9-b986-3b9fc00620ca', 'tenant-c', NULL, 'a883c6d3-eb8e-47b1-9561-16941ab56222', 'v1', 'tenant-c の記憶 8 東京 会議 プロジェクト3', '27955d03f0fb4db217579a1e5dbf74beed76d3f569305b1ab21cd24db6b92e36', 'tenant-c の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.428Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a883c6d3-eb8e-47b1-9561-16941ab56222"}', 'contested', NULL, '5288b42a-c6a1-43ed-8586-d61148b7b554', '{}', NULL, '2026-10-07 19:12:50.43+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.051+09', 'ready', NULL, '2026-10-07 19:12:50.431365+09', '2026-10-07 19:12:50.595217+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('fe4acc2c-fdaa-459f-8531-86f25bd8cec5', 'tenant-c', NULL, '22e21955-e7e7-4944-ac09-377a1b29f8ac', 'v1', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'd8961ae07e5a93b6b0dc84ea6ee4aa46d7a585e6dfcbda5aaddc38a2ce3974b6', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.435Z", "kind": "stated", "speaker": "user", "sourceObservationId": "22e21955-e7e7-4944-ac09-377a1b29f8ac"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.436+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.057+09', 'ready', NULL, '2026-10-07 19:12:50.438718+09', '2026-10-07 19:12:50.598482+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('e73742eb-1914-4fcd-abf7-18acda3a8c38', 'tenant-c', NULL, 'e3244b2b-78bb-4f10-b1da-33828541e130', 'v1', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'be6295fd3fa665a4400e99e456e7ac4a6311b950abd5ab167494cf5cf1661dc4', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.446Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e3244b2b-78bb-4f10-b1da-33828541e130"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.448+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.069+09', 'ready', NULL, '2026-10-07 19:12:50.448591+09', '2026-10-07 19:12:50.599753+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('14dc000d-49d1-452a-8e21-085af5345688', 'tenant-c', NULL, '320caf3c-1695-4b28-bbe7-9bda8cb1cb06', 'v1', '[purged]', '90508b50cef379d5c03fa9f0c876b432c0e3fe77e30b0a0ccc82349c9d4a406f', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.452Z", "kind": "stated", "speaker": "user", "sourceObservationId": "320caf3c-1695-4b28-bbe7-9bda8cb1cb06"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.454+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.075+09', 'ready', '2026-10-07 19:12:50.603+09', '2026-10-07 19:12:50.454706+09', '2026-10-07 19:12:50.603295+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('1e76ed11-8f26-4410-b15e-33cf393b2da7', 'tenant-a2', NULL, '362be6f1-a44c-4d6e-82de-8f181cd1e52b', 'v1', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'a785d27623732af65fc0f05c80ea5e8638cd85eb944016167297bd92393c0331', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.651Z", "kind": "stated", "speaker": "user", "sourceObservationId": "362be6f1-a44c-4d6e-82de-8f181cd1e52b"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.653+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.274+09', 'ready', NULL, '2026-10-07 19:12:50.653552+09', '2026-10-07 19:12:50.710855+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7218f6ab-49f5-4800-8530-dbc685bee1fe', 'tenant-a2', NULL, '96f08daa-eb63-40af-bc7c-3443951c21cf', 'v1', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', '2ff9054147bebbf3ab7b87786763739a75177d4a5b1f441bea040bf1eca421f4', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.665Z", "kind": "stated", "speaker": "user", "sourceObservationId": "96f08daa-eb63-40af-bc7c-3443951c21cf"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.666+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.287+09', 'ready', NULL, '2026-10-07 19:12:50.667385+09', '2026-10-07 19:12:50.71809+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('8574a714-8b1b-4dd8-9669-8b8fb66a4fde', 'tenant-a2', NULL, '4d71dce4-fd28-4028-9e67-3febcb98cae4', 'v1', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', '914fb28b9e9744124fe125428a1d2ccdd0770428843fc02994496676178c35ee', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.678Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4d71dce4-fd28-4028-9e67-3febcb98cae4"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.679+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.3+09', 'ready', NULL, '2026-10-07 19:12:50.679872+09', '2026-10-07 19:12:50.72518+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('708568e6-0191-4f0e-a63c-af832f595084', 'tenant-a2', NULL, '4e14258c-ccc0-4310-85f0-d47091c681d2', 'v1', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', '24ab90528718614c3e988124ed86cb1748700763560be7ef27c8bf4b5dcfd1ab', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.660Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4e14258c-ccc0-4310-85f0-d47091c681d2"}', 'superseded', '7218f6ab-49f5-4800-8530-dbc685bee1fe', NULL, '{}', NULL, '2026-10-07 19:12:50.662+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.283+09', 'ready', NULL, '2026-10-07 19:12:50.662456+09', '2026-10-07 19:12:50.755253+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('28d2e134-829b-43cd-96a4-27c990741913', 'tenant-a2', NULL, '0a5fe51f-cd65-4108-94bf-9c52fe12b284', 'v1', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', '7592207a458219fa91a20d15fb9715e0462c1b13647e460421449a8734cc3f3b', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.670Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0a5fe51f-cd65-4108-94bf-9c52fe12b284"}', 'contested', NULL, 'c73fe627-c93a-4e4c-ae18-9b6313984f2c', '{}', NULL, '2026-10-07 19:12:50.672+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.293+09', 'ready', NULL, '2026-10-07 19:12:50.672474+09', '2026-10-07 19:12:50.756883+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('deeae107-b83d-4965-8898-04e20b6c725f', 'tenant-a2', NULL, '9eee59e2-c7fa-4476-9f1b-2cf8daf4d1b2', 'v1', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', '4cf1d599eeca369fd9803aad38e37386c99caf014b2df0588842e802cb851f62', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.646Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9eee59e2-c7fa-4476-9f1b-2cf8daf4d1b2"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.648+09', '2026-10-07 19:12:50.779+09', NULL, NULL, 1, 720, '2027-02-14 11:00:08.4+09', 'ready', NULL, '2026-10-07 19:12:50.648583+09', '2026-10-07 19:12:50.780037+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('7bcb70db-14e5-4b30-834d-a0c149636e5f', 'tenant-a2', NULL, 'b31bc462-fa23-4be2-8f65-b90f2dcb84d0', 'v1', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'cc6965c4ce873014f25affb39c4d6773bd8fb57667bfa6de70490b30eeb8b9c2', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.632Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b31bc462-fa23-4be2-8f65-b90f2dcb84d0"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.634+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.255+09', 'ready', NULL, '2026-10-07 19:12:50.63471+09', '2026-10-07 19:12:50.699716+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a75c0a9e-8fc3-404f-9f01-08bd0a051f71', 'tenant-a2', NULL, 'aeec1d0f-746d-4a22-87b0-44a7aecb1305', 'v1', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', '98db05eaf2b468995ca8ddfb04238b6a3f78950faff175f1bfb6be45a8249e43', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.638Z", "kind": "stated", "speaker": "user", "sourceObservationId": "aeec1d0f-746d-4a22-87b0-44a7aecb1305"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.64+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.261+09', 'ready', NULL, '2026-10-07 19:12:50.641112+09', '2026-10-07 19:12:50.7034+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('f6c05d07-e9f7-4313-886e-07ec9329f49e', 'tenant-a2', NULL, 'b27d6493-8c52-4f5f-a2a4-8e339ef3da4f', 'v1', 'tenant-a2 FAIL 埋め込み失敗 東京', '72456a5d7a68e3f7d1e7d082bd8429d137478336dc0b7ab44c25aae0508cf9c7', 'tenant-a2 FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.692Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b27d6493-8c52-4f5f-a2a4-8e339ef3da4f"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.693+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.314+09', 'failed', NULL, '2026-10-07 19:12:50.693832+09', '2026-10-07 19:12:50.734657+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('86da63ef-213c-4400-ae9f-d57637485361', 'tenant-a2', NULL, 'e5f26b59-5901-4593-8ab4-00afdba5a24e', 'v1', 'tenant-a2 未埋め込み 2', '361bf58e0bbb5d4804764e21fd48bddde845290c4fcd3281b746852036325696', 'tenant-a2 未埋め込み 2', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.748Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e5f26b59-5901-4593-8ab4-00afdba5a24e"}', 'active', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.75+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.371+09', 'skipped', NULL, '2026-10-07 19:12:50.750764+09', '2026-10-07 19:12:50.753596+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('c73fe627-c93a-4e4c-ae18-9b6313984f2c', 'tenant-a2', NULL, '4469cb10-1a12-4166-a8c0-be27fe5911cb', 'v1', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', '97de39f5fe1e8a6b2164b4726c2ae28bd112a4222632a171a6a79d866131fa79', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.682Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4469cb10-1a12-4166-a8c0-be27fe5911cb"}', 'contested', NULL, '28d2e134-829b-43cd-96a4-27c990741913', '{}', NULL, '2026-10-07 19:12:50.683+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.304+09', 'ready', NULL, '2026-10-07 19:12:50.684102+09', '2026-10-07 19:12:50.756883+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('a0015453-f75e-47e2-b0bc-99f055bd5a4c', 'tenant-a2', NULL, 'a0ba71ba-b950-42db-b53e-d05021c0fa9b', 'v1', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'f43da00aa2d66eb30de895210fc22e5cba0548b91eb41edc808208389480c46c', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.688Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a0ba71ba-b950-42db-b53e-d05021c0fa9b"}', 'archived', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.689+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.31+09', 'ready', NULL, '2026-10-07 19:12:50.690002+09', '2026-10-07 19:12:50.75943+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('ae32d300-498f-4ab6-9216-e34c3658ca49', 'tenant-a2', NULL, '3a7b4253-481f-472f-962b-d6380095ff1a', 'v1', 'tenant-a2 未埋め込み 0', '096af51a3f55ac6f12d4f7ae6b8dadd71299c722c9f56ac9764db3bd05d536e4', 'tenant-a2 未埋め込み 0', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.736Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3a7b4253-481f-472f-962b-d6380095ff1a"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.738+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.359+09', 'pending', NULL, '2026-10-07 19:12:50.738613+09', '2026-10-07 19:12:50.760584+09', NULL, NULL, NULL, '{}', NULL, NULL);
INSERT INTO public.memories VALUES ('4f23dd19-cf60-4aa8-99c9-67d77f6d484c', 'tenant-a2', NULL, 'b4eb8c6a-c617-4ba7-8e8f-ad17163e20a8', 'v1', '[purged]', 'e78005a62ce1fe1dc602590187cd521751267c830e60191f8b6622dafb10a298', '[purged]', 'llm', 'stated', '{"at": "2026-10-07T10:12:50.741Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b4eb8c6a-c617-4ba7-8e8f-ad17163e20a8"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-10-07 19:12:50.743+09', NULL, NULL, NULL, 1, 720, '2027-02-14 11:00:08.364+09', 'pending', '2026-10-07 19:12:50.763+09', '2026-10-07 19:12:50.744298+09', '2026-10-07 19:12:50.76356+09', NULL, NULL, NULL, '{}', NULL, NULL);


--
-- Data for Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '87b0af80-4a09-483a-8937-d7a8299cf069', '[16,772,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.468401+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'a99765fb-053f-4be4-ae02-213c695e85ec', '[16,773,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.473003+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '953ed106-e95f-4366-8e11-65e7c7850739', '[16,774,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.476006+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '36b1914c-9a39-49c8-a1ca-0e7d9aba6101', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.479234+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '6804edb4-8c73-4b01-8f9b-cfde9abe14cc', '[16,776,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.483258+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '514f505c-2984-4887-ad28-bf84d58a22b2', '[16,777,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.486416+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '5288b42a-c6a1-43ed-8586-d61148b7b554', '[16,778,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.489428+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '3fd82bd2-eb5c-4ef0-b063-859fd53c4924', '[16,779,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.492375+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '294f74c8-caf3-43f9-b986-3b9fc00620ca', '[16,780,45,210]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.495887+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'fe4acc2c-fdaa-459f-8531-86f25bd8cec5', '[16,781,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.504823+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'e73742eb-1914-4fcd-abf7-18acda3a8c38', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-10-07 19:12:50.509504+09');


--
-- Data for Name: memory_embeddings_test_fixture_model_3; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '32b68e43-7607-43ce-968b-0b780cfe4245', '[677,880,478]', 'fixture-model', '2026-10-07 19:12:49.866834+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '9da74c9a-e84e-4c92-9403-a9644ddfc4e2', '[678,881,478]', 'fixture-model', '2026-10-07 19:12:49.871226+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '30fc99e8-5f10-4be6-8010-b10d910ce337', '[679,882,478]', 'fixture-model', '2026-10-07 19:12:49.874413+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '6125525a-ae5f-4bdf-8cca-a625c29ca568', '[0,0,0]', 'fixture-model', '2026-10-07 19:12:49.87775+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '127c9455-d0f5-4d78-bcc2-ff1fda91b591', '[681,884,478]', 'fixture-model', '2026-10-07 19:12:49.882958+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '94f35c86-e0c2-4754-849c-68bb1d35bcb7', '[677,885,478]', 'fixture-model', '2026-10-07 19:12:49.888919+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd0cc5de2-ea0c-475c-bb6a-0a89874cbede', '[678,886,478]', 'fixture-model', '2026-10-07 19:12:49.892645+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd75349ca-82d1-417a-a673-858338419917', '[679,887,478]', 'fixture-model', '2026-10-07 19:12:49.896137+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '05371d53-f656-469d-be70-9f30b9ea4c0c', '[680,888,478]', 'fixture-model', '2026-10-07 19:12:49.899058+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '16eadbc1-1bf8-4efa-8a2f-a64d0d567134', '[681,889,478]', 'fixture-model', '2026-10-07 19:12:49.903196+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd9549aaa-52dd-473d-b1b9-05b29f1f821b', '[0,0,0]', 'fixture-model', '2026-10-07 19:12:49.907498+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '95565971-61a9-48d4-8bf0-6146c1b18ab4', '[855,769,464]', 'fixture-model', '2026-10-07 19:12:49.913882+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'e385d8b3-b308-4c04-906c-e9df8b7efb5b', '[855,770,465]', 'fixture-model', '2026-10-07 19:12:49.917532+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '8e77776f-9fac-490a-a360-03f046b63b21', '[855,771,466]', 'fixture-model', '2026-10-07 19:12:49.920934+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '45289fa9-c141-49e8-aa27-403947904678', '[855,767,467]', 'fixture-model', '2026-10-07 19:12:49.924347+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '8dc7ffd1-b4c8-4396-944e-cc8905b390f2', '[855,768,468]', 'fixture-model', '2026-10-07 19:12:49.927572+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '96b496be-f3f0-4cea-aaa4-6ca6469d2514', '[0,0,0]', 'fixture-model', '2026-10-07 19:12:49.930384+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd83a8a10-71ac-47f7-98cd-866c2109058f', '[855,770,470]', 'fixture-model', '2026-10-07 19:12:49.933308+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c32a3934-086f-4808-b9f8-bf1d05d13413', '[855,771,471]', 'fixture-model', '2026-10-07 19:12:49.93618+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '3c6587dd-bed0-4a33-a929-cef895bcc1c2', '[855,768,462]', 'fixture-model', '2026-10-07 19:12:49.938875+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'c60d04c8-7f18-40ac-b425-117dcad2b9c4', '[855,769,463]', 'fixture-model', '2026-10-07 19:12:49.943617+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '165a96af-6587-4299-a87a-b08c581ccf0c', '[855,770,464]', 'fixture-model', '2026-10-07 19:12:49.950301+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '1031045a-5312-41df-aa4f-cbeb244c9676', '[855,771,465]', 'fixture-model', '2026-10-07 19:12:49.953797+09');


--
-- Data for Name: memory_embeddings_testkit_deterministic_8; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '3f2ddb6d-3ebb-4f2c-b820-967569432b05', '[839,69,404,38,174,703,638,168]', 'deterministic', '2026-10-07 19:12:50.190169+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '0ec8e879-c4d6-448c-9751-1857aec8159e', '[839,69,404,39,174,704,638,168]', 'deterministic', '2026-10-07 19:12:50.196876+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e8d5424f-0a9a-451e-9f14-77d672705c70', '[839,69,404,40,174,705,638,168]', 'deterministic', '2026-10-07 19:12:50.200551+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '263bb4c9-6752-4889-ae08-5a96e72c4902', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:50.207637+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'ecdef4b9-eb0c-41db-8c13-da58f544686a', '[839,69,404,42,174,707,638,168]', 'deterministic', '2026-10-07 19:12:50.219138+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '5cab23bf-8349-4f08-82c4-fcc05b183999', '[839,69,404,38,174,708,638,168]', 'deterministic', '2026-10-07 19:12:50.230606+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '84d27a31-017c-4d50-b5b2-23a5bfb747c1', '[839,69,404,39,174,709,638,168]', 'deterministic', '2026-10-07 19:12:50.241669+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '9b1fa9a7-1d68-4d06-82b7-029b5e425d28', '[839,69,404,40,174,710,638,168]', 'deterministic', '2026-10-07 19:12:50.255718+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e75d25a6-e93e-4982-af68-f44c408aa00e', '[839,69,404,41,174,711,638,168]', 'deterministic', '2026-10-07 19:12:50.260268+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '2904e9a5-cd88-4985-b9b9-95798047b0c3', '[839,69,404,42,174,712,638,168]', 'deterministic', '2026-10-07 19:12:50.264148+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'ac6d95fd-7cb6-4f01-b633-9a5bc2bf5e05', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:50.26718+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'b01b630d-8c27-43b0-934a-759588d7f954', '[218,229,101,23,993,197,634,691]', 'deterministic', '2026-10-07 19:12:50.273496+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '453b883d-1d64-4397-b6bd-f9b42c4d9a52', '[218,229,101,23,994,197,635,691]', 'deterministic', '2026-10-07 19:12:50.276353+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '6233d0ba-3289-4b18-bf47-3ad3afd3c613', '[218,229,101,23,995,197,636,691]', 'deterministic', '2026-10-07 19:12:50.279065+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'fc49847e-02c0-4b33-a5fb-f4cb7bd4ebb5', '[218,229,101,23,991,197,637,691]', 'deterministic', '2026-10-07 19:12:50.281881+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e5987c84-2225-4e1c-8df0-59615e473121', '[218,229,101,23,992,197,638,691]', 'deterministic', '2026-10-07 19:12:50.284856+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'cd3efb23-07cb-490c-89d3-23195c957396', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:50.289703+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '7bcb70db-14e5-4b30-834d-a0c149636e5f', '[236,824,78,391,51,180,632,690]', 'deterministic', '2026-10-07 19:12:50.698756+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'a75c0a9e-8fc3-404f-9f01-08bd0a051f71', '[236,824,78,391,52,180,633,690]', 'deterministic', '2026-10-07 19:12:50.70259+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'deeae107-b83d-4965-8898-04e20b6c725f', '[236,824,78,391,53,180,634,690]', 'deterministic', '2026-10-07 19:12:50.707034+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '1e76ed11-8f26-4410-b15e-33cf393b2da7', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-10-07 19:12:50.709987+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '708568e6-0191-4f0e-a63c-af832f595084', '[236,824,78,391,55,180,636,690]', 'deterministic', '2026-10-07 19:12:50.71299+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '7218f6ab-49f5-4800-8530-dbc685bee1fe', '[236,824,78,391,51,180,637,690]', 'deterministic', '2026-10-07 19:12:50.717224+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '28d2e134-829b-43cd-96a4-27c990741913', '[236,824,78,391,52,180,638,690]', 'deterministic', '2026-10-07 19:12:50.720644+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '8574a714-8b1b-4dd8-9669-8b8fb66a4fde', '[236,824,78,391,53,180,639,690]', 'deterministic', '2026-10-07 19:12:50.724406+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'c73fe627-c93a-4e4c-ae18-9b6313984f2c', '[236,824,78,391,54,180,640,690]', 'deterministic', '2026-10-07 19:12:50.728359+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'a0015453-f75e-47e2-b0bc-99f055bd5a4c', '[236,824,78,391,55,180,641,690]', 'deterministic', '2026-10-07 19:12:50.731665+09');


--
-- Data for Name: memory_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_events VALUES ('b7bb9485-8158-4474-916d-a2fe5ad11b1a', 'tenant-a', '32b68e43-7607-43ce-968b-0b780cfe4245', 'created', '2026-10-07 19:12:49.7+09', '{"type": "system"}', 'tenant-a の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f2bd800e-ae1d-4142-8a33-90d6d0d5fb5b"}');
INSERT INTO public.memory_events VALUES ('a4e27c64-7a1d-4079-8f28-c662f2c1b76c', 'tenant-a', '9da74c9a-e84e-4c92-9403-a9644ddfc4e2', 'created', '2026-10-07 19:12:49.709+09', '{"type": "system"}', 'tenant-a の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "dac5d34f-27b5-4774-b69c-a52741f102ca"}');
INSERT INTO public.memory_events VALUES ('2d179330-9e72-4e59-9c7c-cfd04cfd7b61', 'tenant-a', '30fc99e8-5f10-4be6-8010-b10d910ce337', 'created', '2026-10-07 19:12:49.715+09', '{"type": "system"}', 'tenant-a の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1d97b1ed-265d-4058-b69d-896f3400ef77"}');
INSERT INTO public.memory_events VALUES ('dc4b9d25-4464-4af2-b0ce-73c4a252fd6b', 'tenant-a', '6125525a-ae5f-4bdf-8cca-a625c29ca568', 'created', '2026-10-07 19:12:49.721+09', '{"type": "system"}', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "03b945b2-3004-4ec2-822d-2087c5a606ac"}');
INSERT INTO public.memory_events VALUES ('d0557640-69dd-49c7-bda4-bc5a329612ae', 'tenant-a', '127c9455-d0f5-4d78-bcc2-ff1fda91b591', 'created', '2026-10-07 19:12:49.73+09', '{"type": "system"}', 'tenant-a の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "90d5e4f0-7a20-4744-b8e5-5435b5e2c8a4"}');
INSERT INTO public.memory_events VALUES ('bfb1f95d-6b25-4fe7-ae65-b67847b051ee', 'tenant-a', '94f35c86-e0c2-4754-849c-68bb1d35bcb7', 'created', '2026-10-07 19:12:49.736+09', '{"type": "system"}', 'tenant-a の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ca0c0a6a-8787-448c-acdc-cd7f3454e2eb"}');
INSERT INTO public.memory_events VALUES ('8a5cf4d5-df38-4f73-a3bf-d905a62cd9ed', 'tenant-a', 'd0cc5de2-ea0c-475c-bb6a-0a89874cbede', 'created', '2026-10-07 19:12:49.741+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5f1af2a1-5bf8-4e9b-a467-51ea0a572373"}');
INSERT INTO public.memory_events VALUES ('a663eb2f-f956-4d4e-89ce-11c71bd7095d', 'tenant-a', 'd75349ca-82d1-417a-a673-858338419917', 'created', '2026-10-07 19:12:49.751+09', '{"type": "system"}', 'tenant-a の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6d1f2115-b891-4b08-b19f-c0f99080b7ee"}');
INSERT INTO public.memory_events VALUES ('6e4710bb-8a7f-4471-827c-225ec474220e', 'tenant-a', '05371d53-f656-469d-be70-9f30b9ea4c0c', 'created', '2026-10-07 19:12:49.763+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "05b46abb-f32c-448f-8377-a1772ecca1e0"}');
INSERT INTO public.memory_events VALUES ('57867866-b693-415c-af33-2c6cfb883b24', 'tenant-a', '16eadbc1-1bf8-4efa-8a2f-a64d0d567134', 'created', '2026-10-07 19:12:49.769+09', '{"type": "system"}', 'tenant-a の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cb13c0ff-5e59-4417-b044-e07bf66b005e"}');
INSERT INTO public.memory_events VALUES ('46ee78f6-48b1-4733-82ea-0144a94d0969', 'tenant-a', 'd9549aaa-52dd-473d-b1b9-05b29f1f821b', 'created', '2026-10-07 19:12:49.776+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9da33a21-616e-418f-9bb2-9073ed702339"}');
INSERT INTO public.memory_events VALUES ('2172eb60-fe1b-4c35-b1e9-14617efbbafd', 'tenant-a', 'c60f211d-5c6f-4945-8a2d-dac179267962', 'created', '2026-10-07 19:12:49.783+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7dec288f-9ddc-4555-8903-1915bd4facf6"}');
INSERT INTO public.memory_events VALUES ('71b378d3-5512-47f0-bff7-013a2262360c', 'tenant-a', '95565971-61a9-48d4-8bf0-6146c1b18ab4', 'created', '2026-10-07 19:12:49.79+09', '{"type": "system"}', 'tenant-a の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b923926d-5979-4f0c-908b-8fbc8b4d045f"}');
INSERT INTO public.memory_events VALUES ('703da0f6-66d0-4c58-9b7c-e5fe0f806513', 'tenant-a', 'e385d8b3-b308-4c04-906c-e9df8b7efb5b', 'created', '2026-10-07 19:12:49.796+09', '{"type": "system"}', 'tenant-a の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2c29aa5b-12ed-4fed-93dc-073814b6be56"}');
INSERT INTO public.memory_events VALUES ('3f79dc36-769c-4e69-a14f-cf99cdf68155', 'tenant-a', '8e77776f-9fac-490a-a360-03f046b63b21', 'created', '2026-10-07 19:12:49.802+09', '{"type": "system"}', 'tenant-a の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "60448c08-b265-48eb-89f6-a329bd2ddd82"}');
INSERT INTO public.memory_events VALUES ('f3cc3e7d-9d07-4adb-b956-e7a6eab0a167', 'tenant-a', '45289fa9-c141-49e8-aa27-403947904678', 'created', '2026-10-07 19:12:49.808+09', '{"type": "system"}', 'tenant-a の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4ff42bf6-a836-47d1-bddc-22eba530577d"}');
INSERT INTO public.memory_events VALUES ('b375e608-c116-4630-bca0-e294627ac60f', 'tenant-a', '8dc7ffd1-b4c8-4396-944e-cc8905b390f2', 'created', '2026-10-07 19:12:49.814+09', '{"type": "system"}', 'tenant-a の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9abda3c3-8a4b-4add-8cec-e2c8e600466b"}');
INSERT INTO public.memory_events VALUES ('ca98e353-4b6d-44fc-8093-f1c88146386f', 'tenant-a', '96b496be-f3f0-4cea-aaa4-6ca6469d2514', 'created', '2026-10-07 19:12:49.819+09', '{"type": "system"}', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "86c53a97-ffa0-4c99-9370-93bac1c93e88"}');
INSERT INTO public.memory_events VALUES ('da47ed63-1ca3-4f34-9e15-8805852466ce', 'tenant-a', 'd83a8a10-71ac-47f7-98cd-866c2109058f', 'created', '2026-10-07 19:12:49.824+09', '{"type": "system"}', 'tenant-a の記憶 18 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "dafa8d14-afaa-483e-989a-bb426bfb34c0"}');
INSERT INTO public.memory_events VALUES ('496f4fce-8c7b-4c38-83de-ad0c75f79be8', 'tenant-a', 'c32a3934-086f-4808-b9f8-bf1d05d13413', 'created', '2026-10-07 19:12:49.83+09', '{"type": "system"}', 'tenant-a の記憶 19 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "753c6226-0436-4ac9-9792-c2380330b295"}');
INSERT INTO public.memory_events VALUES ('03b57912-2e10-416e-a4b0-d85100f45218', 'tenant-a', '3c6587dd-bed0-4a33-a929-cef895bcc1c2', 'created', '2026-10-07 19:12:49.835+09', '{"type": "system"}', 'tenant-a の記憶 20 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "fa90f474-0d99-43a0-9567-db3c096ab749"}');
INSERT INTO public.memory_events VALUES ('c30fd1ea-3e3e-42b7-82b4-020e1b3259ae', 'tenant-a', 'c60d04c8-7f18-40ac-b425-117dcad2b9c4', 'created', '2026-10-07 19:12:49.841+09', '{"type": "system"}', 'tenant-a の記憶 21 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "54069544-b88c-4a20-b8f9-3079df03663a"}');
INSERT INTO public.memory_events VALUES ('329e42bd-0428-4f4e-ac5d-a621f7ae982b', 'tenant-a', '165a96af-6587-4299-a87a-b08c581ccf0c', 'created', '2026-10-07 19:12:49.85+09', '{"type": "system"}', 'tenant-a の記憶 22 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "134c45fd-6b42-4bd1-910e-74023fc45912"}');
INSERT INTO public.memory_events VALUES ('1875453a-8685-4907-bb77-4b6ba415a494', 'tenant-a', '1031045a-5312-41df-aa4f-cbeb244c9676', 'created', '2026-10-07 19:12:49.856+09', '{"type": "system"}', 'tenant-a の記憶 23 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b5107091-31f8-4a6c-b62d-af7da5d02e56"}');
INSERT INTO public.memory_events VALUES ('ac4acf9d-098c-4ee7-9039-8269cdea0a57', 'tenant-a', 'ca48985b-a8be-472d-b44d-66f9f27d7427', 'created', '2026-10-07 19:12:49.862+09', '{"type": "system"}', 'tenant-a FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7f6c3d77-33c2-4c43-b620-578e18912b20"}');
INSERT INTO public.memory_events VALUES ('a1655c01-656e-41e0-b178-18e01d1ab3e8', 'tenant-a', 'f56e4e56-18b6-4be9-8635-66f70bf99079', 'created', '2026-10-07 19:12:49.975+09', '{"type": "system"}', 'tenant-a 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0655d0e4-5d79-41ba-9465-b97319b9d042"}');
INSERT INTO public.memory_events VALUES ('84d38eb5-3c1f-4773-9425-d0260ca17661', 'tenant-a', 'f113ce19-c359-4019-821e-36a0783e9a4b', 'created', '2026-10-07 19:12:49.981+09', '{"type": "system"}', 'tenant-a 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9d404363-788e-4264-9a7e-81c2bf2467f7"}');
INSERT INTO public.memory_events VALUES ('9b900d28-3397-46d2-b3c1-6199d8646f26', 'tenant-a', 'f0e54766-eb5b-4750-a41b-e686eeaf8a26', 'created', '2026-10-07 19:12:49.987+09', '{"type": "system"}', 'tenant-a 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0b36b7d3-04d0-4e9c-bc51-003718185601"}');
INSERT INTO public.memory_events VALUES ('cb41c19a-2697-4b2d-8bb6-3253873b8c8a', 'tenant-a', 'd0cc5de2-ea0c-475c-bb6a-0a89874cbede', 'updated', '2026-10-07 19:12:49.993+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "05371d53-f656-469d-be70-9f30b9ea4c0c"}');
INSERT INTO public.memory_events VALUES ('ae24eb26-b00e-421f-9083-0fce1f0ee94c', 'tenant-a', '05371d53-f656-469d-be70-9f30b9ea4c0c', 'updated', '2026-10-07 19:12:49.993+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "d0cc5de2-ea0c-475c-bb6a-0a89874cbede"}');
INSERT INTO public.memory_events VALUES ('816c68d1-a342-4ec6-b504-0065ff996a51', 'tenant-a', 'd9549aaa-52dd-473d-b1b9-05b29f1f821b', 'forgotten', '2026-10-07 19:12:50.001+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('91aeaf46-880a-4aec-b918-85122113fb5f', 'tenant-a', 'c60f211d-5c6f-4945-8a2d-dac179267962', 'forgotten', '2026-10-07 19:12:50.009+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('d03d8887-4488-4ea6-a49a-ccd239d157eb', 'tenant-a', 'c60f211d-5c6f-4945-8a2d-dac179267962', 'purged', '2026-10-07 19:12:50.012+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('0e98a845-eb95-4233-851a-a7aaa9d7a5b7', 'tenant-b', '3f2ddb6d-3ebb-4f2c-b820-967569432b05', 'created', '2026-10-07 19:12:50.062+09', '{"type": "system"}', 'tenant-b の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "41a79a3b-3a5c-4f9e-8c57-3609e7b5d956"}');
INSERT INTO public.memory_events VALUES ('96c666e4-8d4a-4dd2-bf17-965c74e7fc21', 'tenant-b', '0ec8e879-c4d6-448c-9751-1857aec8159e', 'created', '2026-10-07 19:12:50.069+09', '{"type": "system"}', 'tenant-b の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e4d4e135-8244-4842-9612-80c15733c9a8"}');
INSERT INTO public.memory_events VALUES ('d2eec2ca-6846-4768-9c1e-d5950e2d2ed2', 'tenant-b', 'e8d5424f-0a9a-451e-9f14-77d672705c70', 'created', '2026-10-07 19:12:50.075+09', '{"type": "system"}', 'tenant-b の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "700eee08-7d19-4b94-842f-ae4a5e65172b"}');
INSERT INTO public.memory_events VALUES ('8ea93d16-e360-40ef-bc8c-0caecba4a50a', 'tenant-b', '263bb4c9-6752-4889-ae08-5a96e72c4902', 'created', '2026-10-07 19:12:50.08+09', '{"type": "system"}', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "384999c2-aec2-40a2-87e9-0193d4ff3d80"}');
INSERT INTO public.memory_events VALUES ('20d67f8e-5173-4dfc-8cc3-bd6132f42960', 'tenant-b', 'ecdef4b9-eb0c-41db-8c13-da58f544686a', 'created', '2026-10-07 19:12:50.088+09', '{"type": "system"}', 'tenant-b の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9071431d-f893-4ebc-840f-07f2458c560d"}');
INSERT INTO public.memory_events VALUES ('e0b226ea-3700-41c4-b9c1-63327f62e74d', 'tenant-b', '5cab23bf-8349-4f08-82c4-fcc05b183999', 'created', '2026-10-07 19:12:50.093+09', '{"type": "system"}', 'tenant-b の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "fa148901-c42b-487f-a30c-b697500af4e6"}');
INSERT INTO public.memory_events VALUES ('ba9b95ca-7494-40ee-a8fb-242ee87be777', 'tenant-b', '84d27a31-017c-4d50-b5b2-23a5bfb747c1', 'created', '2026-10-07 19:12:50.101+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "57ee7bf1-8d9c-464d-9a41-3c4a9af16503"}');
INSERT INTO public.memory_events VALUES ('3109cfa7-9828-47c8-b74f-e58f7a0adc4c', 'tenant-b', '9b1fa9a7-1d68-4d06-82b7-029b5e425d28', 'created', '2026-10-07 19:12:50.107+09', '{"type": "system"}', 'tenant-b の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1f865044-7d5e-4722-bd18-58feb9b30523"}');
INSERT INTO public.memory_events VALUES ('15275480-7e11-4051-8316-048eb31814f6', 'tenant-b', 'e75d25a6-e93e-4982-af68-f44c408aa00e', 'created', '2026-10-07 19:12:50.112+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3efd4a19-d1a2-43db-b154-c9236dc62928"}');
INSERT INTO public.memory_events VALUES ('3b88f0fb-933f-4ad1-a2e0-2fb9b9573607', 'tenant-b', '2904e9a5-cd88-4985-b9b9-95798047b0c3', 'created', '2026-10-07 19:12:50.117+09', '{"type": "system"}', 'tenant-b の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "87f3be43-77d7-4421-9944-d968e75e3a5f"}');
INSERT INTO public.memory_events VALUES ('614525b0-5568-4c7b-b2ee-1d614b70cbf9', 'tenant-b', 'ac6d95fd-7cb6-4f01-b633-9a5bc2bf5e05', 'created', '2026-10-07 19:12:50.121+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b4815f90-b361-49de-a947-a8192d20e60e"}');
INSERT INTO public.memory_events VALUES ('83104018-30e7-4f6f-8809-745563cdc756', 'tenant-b', '5bf76290-e5e2-4fa4-bd2f-2737ef5578c8', 'created', '2026-10-07 19:12:50.126+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "da4cf9f6-8876-4019-8c8e-e631ffedfa30"}');
INSERT INTO public.memory_events VALUES ('a10fb639-9c89-4273-b4b9-7ef86530abf4', 'tenant-b', 'b01b630d-8c27-43b0-934a-759588d7f954', 'created', '2026-10-07 19:12:50.13+09', '{"type": "system"}', 'tenant-b の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b7a63156-f81c-48d9-83e4-351e056bc938"}');
INSERT INTO public.memory_events VALUES ('ebbf0bab-b173-43b9-97ea-2e1cefb13fdf', 'tenant-b', '453b883d-1d64-4397-b6bd-f9b42c4d9a52', 'created', '2026-10-07 19:12:50.135+09', '{"type": "system"}', 'tenant-b の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "86ca5159-500b-484c-b1d0-5076b69a1133"}');
INSERT INTO public.memory_events VALUES ('c6c4b36a-dd3f-4731-8d11-8ea460e70059', 'tenant-b', '6233d0ba-3289-4b18-bf47-3ad3afd3c613', 'created', '2026-10-07 19:12:50.141+09', '{"type": "system"}', 'tenant-b の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1f53c121-022c-4a25-96ac-fd59e6c8fd20"}');
INSERT INTO public.memory_events VALUES ('0a112a40-0c55-4813-a634-c628cc373d80', 'tenant-b', 'fc49847e-02c0-4b33-a5fb-f4cb7bd4ebb5', 'created', '2026-10-07 19:12:50.147+09', '{"type": "system"}', 'tenant-b の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6d0a052c-12b8-4d0e-93bf-b414bf92a753"}');
INSERT INTO public.memory_events VALUES ('b54d131c-34b2-4fb1-b5ef-037be9bdd967', 'tenant-b', 'e5987c84-2225-4e1c-8df0-59615e473121', 'created', '2026-10-07 19:12:50.174+09', '{"type": "system"}', 'tenant-b の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1a84ab64-d393-4c5a-adba-128c463e7473"}');
INSERT INTO public.memory_events VALUES ('bccba601-dc52-473a-a55c-51c20a5e063a', 'tenant-b', 'cd3efb23-07cb-490c-89d3-23195c957396', 'created', '2026-10-07 19:12:50.181+09', '{"type": "system"}', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d7b83ff4-5468-41b8-80bb-eb60914e1c6c"}');
INSERT INTO public.memory_events VALUES ('452bdcd5-98b5-4697-adb4-97478925d8f0', 'tenant-b', '60f0fac6-c743-4f0e-9a42-608e8c215244', 'created', '2026-10-07 19:12:50.186+09', '{"type": "system"}', 'tenant-b FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7a20e5aa-b947-4a07-af13-25b2c7ab7300"}');
INSERT INTO public.memory_events VALUES ('6463dac4-5834-4ac1-948f-8e4e4eebd73f', 'tenant-b', 'b18db25c-08c7-4b7a-9646-95621eab1b91', 'created', '2026-10-07 19:12:50.314+09', '{"type": "system"}', 'tenant-b 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "30d5c5c9-0d8f-4aef-8370-eafc26b9d325"}');
INSERT INTO public.memory_events VALUES ('205ff7b1-477a-4114-8579-f11256ec86b0', 'tenant-b', '8cae5ddc-4556-4e30-8110-48b3c11fcca8', 'created', '2026-10-07 19:12:50.328+09', '{"type": "system"}', 'tenant-b 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cb557362-bcdc-4808-809c-258a4d240831"}');
INSERT INTO public.memory_events VALUES ('0ac6c135-dae0-4f39-9714-f985cfd97cde', 'tenant-b', 'b347bac9-0041-4d10-8a6c-10f4e9c75ebc', 'created', '2026-10-07 19:12:50.334+09', '{"type": "system"}', 'tenant-b 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d56da5ee-384a-4119-8805-dcc456b33cc3"}');
INSERT INTO public.memory_events VALUES ('14667d15-4302-4756-9edf-0b425bcb5107', 'tenant-b', '84d27a31-017c-4d50-b5b2-23a5bfb747c1', 'updated', '2026-10-07 19:12:50.339+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "e75d25a6-e93e-4982-af68-f44c408aa00e"}');
INSERT INTO public.memory_events VALUES ('ac4782e1-fbc7-425a-9398-30a5c3fa2393', 'tenant-b', 'e75d25a6-e93e-4982-af68-f44c408aa00e', 'updated', '2026-10-07 19:12:50.339+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "84d27a31-017c-4d50-b5b2-23a5bfb747c1"}');
INSERT INTO public.memory_events VALUES ('6edf204d-3f70-4471-9aec-e30006dd3a72', 'tenant-b', 'ac6d95fd-7cb6-4f01-b633-9a5bc2bf5e05', 'forgotten', '2026-10-07 19:12:50.345+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('4fe0bb20-51c0-43f4-8de9-e424c6edf864', 'tenant-b', '5bf76290-e5e2-4fa4-bd2f-2737ef5578c8', 'forgotten', '2026-10-07 19:12:50.353+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('f6ddb6cd-da2b-4345-8c15-cd4c14a78969', 'tenant-b', '5bf76290-e5e2-4fa4-bd2f-2737ef5578c8', 'purged', '2026-10-07 19:12:50.355+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('1dc3d6c3-06cb-462d-b08e-c444200710cc', 'tenant-b', 'e75d25a6-e93e-4982-af68-f44c408aa00e', 'forgotten', '2026-10-07 19:12:50.362+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "fixture: orphaned contested"}');
INSERT INTO public.memory_events VALUES ('27c64a92-5170-41da-8ae1-40d4272486b1', 'tenant-c', '87b0af80-4a09-483a-8937-d7a8299cf069', 'created', '2026-10-07 19:12:50.386+09', '{"type": "system"}', 'tenant-c の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1ae14a1c-e686-4b53-a5d5-f4f1b5d3d77e"}');
INSERT INTO public.memory_events VALUES ('f3e98472-f444-47e2-80ec-ffe57fe5498f', 'tenant-c', 'a99765fb-053f-4be4-ae02-213c695e85ec', 'created', '2026-10-07 19:12:50.392+09', '{"type": "system"}', 'tenant-c の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e58eb51c-71af-4c5c-b4fb-f1592d668364"}');
INSERT INTO public.memory_events VALUES ('fbad94c8-674c-4f3b-ac81-e5f1427d0cea', 'tenant-c', '953ed106-e95f-4366-8e11-65e7c7850739', 'created', '2026-10-07 19:12:50.398+09', '{"type": "system"}', 'tenant-c の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ff38eb67-753f-43ba-91cb-63faca683dcb"}');
INSERT INTO public.memory_events VALUES ('e580ba8f-2751-4234-a099-5fae98a07a48', 'tenant-c', '36b1914c-9a39-49c8-a1ca-0e7d9aba6101', 'created', '2026-10-07 19:12:50.403+09', '{"type": "system"}', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2e18df03-570a-45f3-a4ed-f30d97a31389"}');
INSERT INTO public.memory_events VALUES ('fad6f250-063f-4228-bb35-f155fee2ba34', 'tenant-c', '6804edb4-8c73-4b01-8f9b-cfde9abe14cc', 'created', '2026-10-07 19:12:50.409+09', '{"type": "system"}', 'tenant-c の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8f17ac01-21c0-49d8-a42c-4bc16c7a8f6b"}');
INSERT INTO public.memory_events VALUES ('b11012e8-7955-40da-bcc8-96df2cb86010', 'tenant-c', '514f505c-2984-4887-ad28-bf84d58a22b2', 'created', '2026-10-07 19:12:50.414+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e4d3b447-6ec9-4e4e-951c-a316592bf919"}');
INSERT INTO public.memory_events VALUES ('d8fe804f-6201-4413-9eb8-a0fca7ae3668', 'tenant-c', '5288b42a-c6a1-43ed-8586-d61148b7b554', 'created', '2026-10-07 19:12:50.42+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "14907a9d-bd37-4dc3-a51d-889192854951"}');
INSERT INTO public.memory_events VALUES ('2bb3d94e-137d-4133-a1ca-e29646c170d2', 'tenant-c', '3fd82bd2-eb5c-4ef0-b063-859fd53c4924', 'created', '2026-10-07 19:12:50.426+09', '{"type": "system"}', 'tenant-c の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "76799240-dfd8-4ed7-a7c7-d519bca90498"}');
INSERT INTO public.memory_events VALUES ('c4a4f921-a0d6-4842-95ff-d616953d6993', 'tenant-c', '294f74c8-caf3-43f9-b986-3b9fc00620ca', 'created', '2026-10-07 19:12:50.433+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a883c6d3-eb8e-47b1-9561-16941ab56222"}');
INSERT INTO public.memory_events VALUES ('12830717-bee3-4286-8e5d-f9514f846123', 'tenant-c', 'fe4acc2c-fdaa-459f-8531-86f25bd8cec5', 'created', '2026-10-07 19:12:50.442+09', '{"type": "system"}', 'tenant-c の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "22e21955-e7e7-4944-ac09-377a1b29f8ac"}');
INSERT INTO public.memory_events VALUES ('aa45f137-d84e-4020-a528-a38340682a89', 'tenant-c', 'e73742eb-1914-4fcd-abf7-18acda3a8c38', 'created', '2026-10-07 19:12:50.451+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e3244b2b-78bb-4f10-b1da-33828541e130"}');
INSERT INTO public.memory_events VALUES ('104be638-ddbc-4dba-891a-2df2ad9bb964', 'tenant-c', '14dc000d-49d1-452a-8e21-085af5345688', 'created', '2026-10-07 19:12:50.456+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "320caf3c-1695-4b28-bbe7-9bda8cb1cb06"}');
INSERT INTO public.memory_events VALUES ('d1e3c21c-a203-4a81-8bd6-56f5dec3a8f3', 'tenant-c', 'c1e8190f-a6d8-4534-bcfd-318832da049a', 'created', '2026-10-07 19:12:50.465+09', '{"type": "system"}', 'tenant-c FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "554085f8-e701-4e54-8cd4-e2fb1a646b71"}');
INSERT INTO public.memory_events VALUES ('7b4913e2-0208-41eb-8555-0a2583b4ff84', 'tenant-c', '7feac528-333d-4360-85af-c2e8303b98fb', 'created', '2026-10-07 19:12:50.566+09', '{"type": "system"}', 'tenant-c 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c4727d49-6035-4046-9f31-05f9bc6df1b1"}');
INSERT INTO public.memory_events VALUES ('7449d846-4f64-41c7-8a98-7078eccac933', 'tenant-c', '790e574d-8baa-4bca-92a4-bbaf44becc82', 'created', '2026-10-07 19:12:50.584+09', '{"type": "system"}', 'tenant-c 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c2b3c5ae-db60-400f-84c3-9a67188036d4"}');
INSERT INTO public.memory_events VALUES ('a2ea3433-b399-4215-b176-b86364665a9a', 'tenant-c', '2117a8ae-5aac-450b-b430-7597276db1a2', 'created', '2026-10-07 19:12:50.589+09', '{"type": "system"}', 'tenant-c 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e274142b-404d-4be4-a9c1-7694651a7d94"}');
INSERT INTO public.memory_events VALUES ('d5483063-e770-4501-a1e4-b01738fc2e43', 'tenant-c', '5288b42a-c6a1-43ed-8586-d61148b7b554', 'updated', '2026-10-07 19:12:50.595+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "294f74c8-caf3-43f9-b986-3b9fc00620ca"}');
INSERT INTO public.memory_events VALUES ('6fa35165-e9a2-4479-a350-e19f2a09ef57', 'tenant-c', '294f74c8-caf3-43f9-b986-3b9fc00620ca', 'updated', '2026-10-07 19:12:50.595+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "5288b42a-c6a1-43ed-8586-d61148b7b554"}');
INSERT INTO public.memory_events VALUES ('c8a0df3d-0073-4861-b6d1-8cc3be15bd41', 'tenant-c', 'e73742eb-1914-4fcd-abf7-18acda3a8c38', 'forgotten', '2026-10-07 19:12:50.599+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('2a13c67e-1de6-4120-8a5e-7ef78a20b296', 'tenant-c', '14dc000d-49d1-452a-8e21-085af5345688', 'forgotten', '2026-10-07 19:12:50.6+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('26eeb8dd-5a96-42d3-ae11-b6356da293fa', 'tenant-c', '14dc000d-49d1-452a-8e21-085af5345688', 'purged', '2026-10-07 19:12:50.603+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('9a3e17c9-b24c-4e7a-af64-8d09481bd3c0', 'tenant-c', '514f505c-2984-4887-ad28-bf84d58a22b2', 'forgotten', '2026-10-07 19:12:50.61+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "fixture: successor forgotten"}');
INSERT INTO public.memory_events VALUES ('9a8c7933-fe42-4706-93a3-3e3bece734bf', 'tenant-a2', '7bcb70db-14e5-4b30-834d-a0c149636e5f', 'created', '2026-10-07 19:12:50.636+09', '{"type": "system"}', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b31bc462-fa23-4be2-8f65-b90f2dcb84d0"}');
INSERT INTO public.memory_events VALUES ('059820dc-bb9b-4035-8ceb-6bf8d508df55', 'tenant-a2', 'a75c0a9e-8fc3-404f-9f01-08bd0a051f71', 'created', '2026-10-07 19:12:50.645+09', '{"type": "system"}', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "aeec1d0f-746d-4a22-87b0-44a7aecb1305"}');
INSERT INTO public.memory_events VALUES ('4929a615-5102-4da8-9eaf-492e47c0c46b', 'tenant-a2', 'deeae107-b83d-4965-8898-04e20b6c725f', 'created', '2026-10-07 19:12:50.65+09', '{"type": "system"}', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9eee59e2-c7fa-4476-9f1b-2cf8daf4d1b2"}');
INSERT INTO public.memory_events VALUES ('cbf8e688-9a62-480b-807f-2ae43f2c117a', 'tenant-a2', '1e76ed11-8f26-4410-b15e-33cf393b2da7', 'created', '2026-10-07 19:12:50.657+09', '{"type": "system"}', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "362be6f1-a44c-4d6e-82de-8f181cd1e52b"}');
INSERT INTO public.memory_events VALUES ('e21d19cd-78a4-441f-a7b7-689d1b71b027', 'tenant-a2', '708568e6-0191-4f0e-a63c-af832f595084', 'created', '2026-10-07 19:12:50.664+09', '{"type": "system"}', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4e14258c-ccc0-4310-85f0-d47091c681d2"}');
INSERT INTO public.memory_events VALUES ('abe7498f-1eca-4efa-8697-88a1edded13b', 'tenant-a2', '7218f6ab-49f5-4800-8530-dbc685bee1fe', 'created', '2026-10-07 19:12:50.669+09', '{"type": "system"}', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "96f08daa-eb63-40af-bc7c-3443951c21cf"}');
INSERT INTO public.memory_events VALUES ('9bf8abcf-5545-4fe7-814d-47dd1162adc2', 'tenant-a2', '28d2e134-829b-43cd-96a4-27c990741913', 'created', '2026-10-07 19:12:50.676+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0a5fe51f-cd65-4108-94bf-9c52fe12b284"}');
INSERT INTO public.memory_events VALUES ('b0bbd9d8-9fde-43f9-8985-e55e1c90513c', 'tenant-a2', '8574a714-8b1b-4dd8-9669-8b8fb66a4fde', 'created', '2026-10-07 19:12:50.681+09', '{"type": "system"}', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4d71dce4-fd28-4028-9e67-3febcb98cae4"}');
INSERT INTO public.memory_events VALUES ('5708246f-786f-4ea4-b55f-7491fceb1a39', 'tenant-a2', 'c73fe627-c93a-4e4c-ae18-9b6313984f2c', 'created', '2026-10-07 19:12:50.685+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4469cb10-1a12-4166-a8c0-be27fe5911cb"}');
INSERT INTO public.memory_events VALUES ('d5814dc8-9b82-4ee9-add8-0b73f60263bf', 'tenant-a2', 'a0015453-f75e-47e2-b0bc-99f055bd5a4c', 'created', '2026-10-07 19:12:50.691+09', '{"type": "system"}', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a0ba71ba-b950-42db-b53e-d05021c0fa9b"}');
INSERT INTO public.memory_events VALUES ('b17d314d-c33a-46d2-8b08-eb1c80e477c9', 'tenant-a2', 'f6c05d07-e9f7-4313-886e-07ec9329f49e', 'created', '2026-10-07 19:12:50.695+09', '{"type": "system"}', 'tenant-a2 FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b27d6493-8c52-4f5f-a2a4-8e339ef3da4f"}');
INSERT INTO public.memory_events VALUES ('9a89ac83-c86b-4f7e-92ae-75671a8e28db', 'tenant-a2', 'ae32d300-498f-4ab6-9216-e34c3658ca49', 'created', '2026-10-07 19:12:50.74+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3a7b4253-481f-472f-962b-d6380095ff1a"}');
INSERT INTO public.memory_events VALUES ('82640108-9315-4e60-a8d5-828917ba0870', 'tenant-a2', '4f23dd19-cf60-4aa8-99c9-67d77f6d484c', 'created', '2026-10-07 19:12:50.747+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b4eb8c6a-c617-4ba7-8e8f-ad17163e20a8"}');
INSERT INTO public.memory_events VALUES ('1c712025-568f-4be6-81e4-c60ff5e5e38c', 'tenant-a2', '86da63ef-213c-4400-ae9f-d57637485361', 'created', '2026-10-07 19:12:50.752+09', '{"type": "system"}', 'tenant-a2 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e5f26b59-5901-4593-8ab4-00afdba5a24e"}');
INSERT INTO public.memory_events VALUES ('49db47fa-7b31-44f8-ae83-a0d0c1539a0d', 'tenant-a2', '28d2e134-829b-43cd-96a4-27c990741913', 'updated', '2026-10-07 19:12:50.756+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "c73fe627-c93a-4e4c-ae18-9b6313984f2c"}');
INSERT INTO public.memory_events VALUES ('c7bcc001-5769-4807-9ab6-4e9d316b6c12', 'tenant-a2', 'c73fe627-c93a-4e4c-ae18-9b6313984f2c', 'updated', '2026-10-07 19:12:50.756+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested", "contestedWithId": "28d2e134-829b-43cd-96a4-27c990741913"}');
INSERT INTO public.memory_events VALUES ('986a5c0f-9460-47d6-8949-73f2b197e71d', 'tenant-a2', 'ae32d300-498f-4ab6-9216-e34c3658ca49', 'forgotten', '2026-10-07 19:12:50.76+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('31f4f2c4-f337-431a-94d8-98ec280eb69d', 'tenant-a2', '4f23dd19-cf60-4aa8-99c9-67d77f6d484c', 'forgotten', '2026-10-07 19:12:50.761+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('3de5c451-2719-4c24-889d-6c192af6f593', 'tenant-a2', '4f23dd19-cf60-4aa8-99c9-67d77f6d484c', 'purged', '2026-10-07 19:12:50.763+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');


--
-- Data for Name: memory_labels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memory_relations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: observations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.observations VALUES ('f2bd800e-ae1d-4142-8a33-90d6d0d5fb5b', 'tenant-a', NULL, 'tenant-a-ext-0', 'utterance', '{"text": "tenant-a の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:49.686+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('dac5d34f-27b5-4774-b69c-a52741f102ca', 'tenant-a', NULL, 'tenant-a-ext-1', 'utterance', '{"text": "tenant-a の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:49.703+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1d97b1ed-265d-4058-b69d-896f3400ef77', 'tenant-a', NULL, 'tenant-a-ext-2', 'utterance', '{"text": "tenant-a の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:49.711+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('03b945b2-3004-4ec2-822d-2087c5a606ac', 'tenant-a', NULL, 'tenant-a-ext-3', 'utterance', '{"text": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:49.716+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('90d5e4f0-7a20-4744-b8e5-5435b5e2c8a4', 'tenant-a', NULL, 'tenant-a-ext-4', 'utterance', '{"text": "tenant-a の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:49.724+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ca0c0a6a-8787-448c-acdc-cd7f3454e2eb', 'tenant-a', NULL, 'tenant-a-ext-5', 'utterance', '{"text": "tenant-a の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:49.731+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5f1af2a1-5bf8-4e9b-a467-51ea0a572373', 'tenant-a', NULL, 'tenant-a-ext-6', 'utterance', '{"text": "tenant-a の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:49.737+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6d1f2115-b891-4b08-b19f-c0f99080b7ee', 'tenant-a', NULL, 'tenant-a-ext-7', 'utterance', '{"text": "tenant-a の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:49.743+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('05b46abb-f32c-448f-8377-a1772ecca1e0', 'tenant-a', NULL, 'tenant-a-ext-8', 'utterance', '{"text": "tenant-a の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:49.753+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('cb13c0ff-5e59-4417-b044-e07bf66b005e', 'tenant-a', NULL, 'tenant-a-ext-9', 'utterance', '{"text": "tenant-a の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:49.764+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9da33a21-616e-418f-9bb2-9073ed702339', 'tenant-a', NULL, 'tenant-a-ext-10', 'utterance', '{"text": "tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:49.771+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7dec288f-9ddc-4555-8903-1915bd4facf6', 'tenant-a', NULL, 'tenant-a-ext-11', 'utterance', '{"text": "tenant-a の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:49.778+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b923926d-5979-4f0c-908b-8fbc8b4d045f', 'tenant-a', NULL, 'tenant-a-ext-12', 'utterance', '{"text": "tenant-a の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:49.785+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2c29aa5b-12ed-4fed-93dc-073814b6be56', 'tenant-a', NULL, 'tenant-a-ext-13', 'utterance', '{"text": "tenant-a の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:49.791+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('60448c08-b265-48eb-89f6-a329bd2ddd82', 'tenant-a', NULL, 'tenant-a-ext-14', 'utterance', '{"text": "tenant-a の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:49.797+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4ff42bf6-a836-47d1-bddc-22eba530577d', 'tenant-a', NULL, 'tenant-a-ext-15', 'utterance', '{"text": "tenant-a の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:49.803+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9abda3c3-8a4b-4add-8cec-e2c8e600466b', 'tenant-a', NULL, 'tenant-a-ext-16', 'utterance', '{"text": "tenant-a の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:49.809+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('86c53a97-ffa0-4c99-9370-93bac1c93e88', 'tenant-a', NULL, 'tenant-a-ext-17', 'utterance', '{"text": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:49.815+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('dafa8d14-afaa-483e-989a-bb426bfb34c0', 'tenant-a', NULL, 'tenant-a-ext-18', 'utterance', '{"text": "tenant-a の記憶 18 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:49.82+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('753c6226-0436-4ac9-9792-c2380330b295', 'tenant-a', NULL, 'tenant-a-ext-19', 'utterance', '{"text": "tenant-a の記憶 19 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:49.826+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('fa90f474-0d99-43a0-9567-db3c096ab749', 'tenant-a', NULL, 'tenant-a-ext-20', 'utterance', '{"text": "tenant-a の記憶 20 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:49.831+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('54069544-b88c-4a20-b8f9-3079df03663a', 'tenant-a', NULL, 'tenant-a-ext-21', 'utterance', '{"text": "tenant-a の記憶 21 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:49.837+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('134c45fd-6b42-4bd1-910e-74023fc45912', 'tenant-a', NULL, 'tenant-a-ext-22', 'utterance', '{"text": "tenant-a の記憶 22 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:49.843+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b5107091-31f8-4a6c-b62d-af7da5d02e56', 'tenant-a', NULL, 'tenant-a-ext-23', 'utterance', '{"text": "tenant-a の記憶 23 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:49.852+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7f6c3d77-33c2-4c43-b620-578e18912b20', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:49.858+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0655d0e4-5d79-41ba-9465-b97319b9d042', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:49.967+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9d404363-788e-4264-9a7e-81c2bf2467f7', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:49.977+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0b36b7d3-04d0-4e9c-bc51-003718185601', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:49.982+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('5d3a2a46-5c2c-4eb2-a95b-ca2f25121274', 'tenant-a', NULL, NULL, 'usage', '{"recallId": "b6b59cb7-cecd-4b47-8764-9dbacf91537d", "usedMemoryIds": ["3c6587dd-bed0-4a33-a929-cef895bcc1c2"]}', NULL, '2026-10-07 19:12:50.05+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('41a79a3b-3a5c-4f9e-8c57-3609e7b5d956', 'tenant-b', NULL, 'tenant-b-ext-0', 'utterance', '{"text": "tenant-b の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.058+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e4d4e135-8244-4842-9612-80c15733c9a8', 'tenant-b', NULL, 'tenant-b-ext-1', 'utterance', '{"text": "tenant-b の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.064+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('700eee08-7d19-4b94-842f-ae4a5e65172b', 'tenant-b', NULL, 'tenant-b-ext-2', 'utterance', '{"text": "tenant-b の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.071+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('384999c2-aec2-40a2-87e9-0193d4ff3d80', 'tenant-b', NULL, 'tenant-b-ext-3', 'utterance', '{"text": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:50.076+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9071431d-f893-4ebc-840f-07f2458c560d', 'tenant-b', NULL, 'tenant-b-ext-4', 'utterance', '{"text": "tenant-b の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:50.081+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('fa148901-c42b-487f-a30c-b697500af4e6', 'tenant-b', NULL, 'tenant-b-ext-5', 'utterance', '{"text": "tenant-b の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.089+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('57ee7bf1-8d9c-464d-9a41-3c4a9af16503', 'tenant-b', NULL, 'tenant-b-ext-6', 'utterance', '{"text": "tenant-b の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.095+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1f865044-7d5e-4722-bd18-58feb9b30523', 'tenant-b', NULL, 'tenant-b-ext-7', 'utterance', '{"text": "tenant-b の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.103+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3efd4a19-d1a2-43db-b154-c9236dc62928', 'tenant-b', NULL, 'tenant-b-ext-8', 'utterance', '{"text": "tenant-b の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:50.109+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('87f3be43-77d7-4421-9944-d968e75e3a5f', 'tenant-b', NULL, 'tenant-b-ext-9', 'utterance', '{"text": "tenant-b の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:50.114+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b4815f90-b361-49de-a947-a8192d20e60e', 'tenant-b', NULL, 'tenant-b-ext-10', 'utterance', '{"text": "tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:50.118+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('da4cf9f6-8876-4019-8c8e-e631ffedfa30', 'tenant-b', NULL, 'tenant-b-ext-11', 'utterance', '{"text": "tenant-b の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.122+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b7a63156-f81c-48d9-83e4-351e056bc938', 'tenant-b', NULL, 'tenant-b-ext-12', 'utterance', '{"text": "tenant-b の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.127+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('86ca5159-500b-484c-b1d0-5076b69a1133', 'tenant-b', NULL, 'tenant-b-ext-13', 'utterance', '{"text": "tenant-b の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:50.131+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1f53c121-022c-4a25-96ac-fd59e6c8fd20', 'tenant-b', NULL, 'tenant-b-ext-14', 'utterance', '{"text": "tenant-b の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:50.137+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('6d0a052c-12b8-4d0e-93bf-b414bf92a753', 'tenant-b', NULL, 'tenant-b-ext-15', 'utterance', '{"text": "tenant-b の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.142+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1a84ab64-d393-4c5a-adba-128c463e7473', 'tenant-b', NULL, 'tenant-b-ext-16', 'utterance', '{"text": "tenant-b の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.157+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d7b83ff4-5468-41b8-80bb-eb60914e1c6c', 'tenant-b', NULL, 'tenant-b-ext-17', 'utterance', '{"text": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:50.175+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('7a20e5aa-b947-4a07-af13-25b2c7ab7300', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:50.182+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('30d5c5c9-0d8f-4aef-8370-eafc26b9d325', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.309+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('cb557362-bcdc-4808-809c-258a4d240831', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.319+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('d56da5ee-384a-4119-8805-dcc456b33cc3', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.33+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a244f010-6ebd-408b-8ffc-dd190e9ab418', 'tenant-b', NULL, NULL, 'usage', '{"recallId": "0c8d8bac-68cd-4c66-8436-ae54a3092f01", "usedMemoryIds": ["6233d0ba-3289-4b18-bf47-3ad3afd3c613"]}', NULL, '2026-10-07 19:12:50.377+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('1ae14a1c-e686-4b53-a5d5-f4f1b5d3d77e', 'tenant-c', NULL, 'tenant-c-ext-0', 'utterance', '{"text": "tenant-c の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.381+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e58eb51c-71af-4c5c-b4fb-f1592d668364', 'tenant-c', NULL, 'tenant-c-ext-1', 'utterance', '{"text": "tenant-c の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.388+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('ff38eb67-753f-43ba-91cb-63faca683dcb', 'tenant-c', NULL, 'tenant-c-ext-2', 'utterance', '{"text": "tenant-c の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.394+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('2e18df03-570a-45f3-a4ed-f30d97a31389', 'tenant-c', NULL, 'tenant-c-ext-3', 'utterance', '{"text": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:50.399+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('8f17ac01-21c0-49d8-a42c-4bc16c7a8f6b', 'tenant-c', NULL, 'tenant-c-ext-4', 'utterance', '{"text": "tenant-c の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:50.405+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e4d3b447-6ec9-4e4e-951c-a316592bf919', 'tenant-c', NULL, 'tenant-c-ext-5', 'utterance', '{"text": "tenant-c の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.41+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('14907a9d-bd37-4dc3-a51d-889192854951', 'tenant-c', NULL, 'tenant-c-ext-6', 'utterance', '{"text": "tenant-c の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.416+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('76799240-dfd8-4ed7-a7c7-d519bca90498', 'tenant-c', NULL, 'tenant-c-ext-7', 'utterance', '{"text": "tenant-c の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.421+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a883c6d3-eb8e-47b1-9561-16941ab56222', 'tenant-c', NULL, 'tenant-c-ext-8', 'utterance', '{"text": "tenant-c の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:50.428+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('22e21955-e7e7-4944-ac09-377a1b29f8ac', 'tenant-c', NULL, 'tenant-c-ext-9', 'utterance', '{"text": "tenant-c の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:50.435+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e3244b2b-78bb-4f10-b1da-33828541e130', 'tenant-c', NULL, 'tenant-c-ext-10', 'utterance', '{"text": "tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:50.446+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('320caf3c-1695-4b28-bbe7-9bda8cb1cb06', 'tenant-c', NULL, 'tenant-c-ext-11', 'utterance', '{"text": "tenant-c の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.452+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('554085f8-e701-4e54-8cd4-e2fb1a646b71', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:50.458+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c4727d49-6035-4046-9f31-05f9bc6df1b1', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.523+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('c2b3c5ae-db60-400f-84c3-9a67188036d4', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.579+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e274142b-404d-4be4-a9c1-7694651a7d94', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.585+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('25417c6f-1d1f-476e-a8af-760ccbe3d7f0', 'tenant-c', NULL, NULL, 'usage', '{"recallId": "e13bdcb9-927e-46de-92c3-2bbf214cff9d", "usedMemoryIds": ["953ed106-e95f-4366-8e11-65e7c7850739"]}', NULL, '2026-10-07 19:12:50.628+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b31bc462-fa23-4be2-8f65-b90f2dcb84d0', 'tenant-a2', NULL, 'tenant-a2-ext-0', 'utterance', '{"text": "tenant-a2 の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.632+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('aeec1d0f-746d-4a22-87b0-44a7aecb1305', 'tenant-a2', NULL, 'tenant-a2-ext-1', 'utterance', '{"text": "tenant-a2 の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.638+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('9eee59e2-c7fa-4476-9f1b-2cf8daf4d1b2', 'tenant-a2', NULL, 'tenant-a2-ext-2', 'utterance', '{"text": "tenant-a2 の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.646+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('362be6f1-a44c-4d6e-82de-8f181cd1e52b', 'tenant-a2', NULL, 'tenant-a2-ext-3', 'utterance', '{"text": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-10-07 19:12:50.651+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4e14258c-ccc0-4310-85f0-d47091c681d2', 'tenant-a2', NULL, 'tenant-a2-ext-4', 'utterance', '{"text": "tenant-a2 の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:50.66+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('96f08daa-eb63-40af-bc7c-3443951c21cf', 'tenant-a2', NULL, 'tenant-a2-ext-5', 'utterance', '{"text": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.665+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('0a5fe51f-cd65-4108-94bf-9c52fe12b284', 'tenant-a2', NULL, 'tenant-a2-ext-6', 'utterance', '{"text": "tenant-a2 の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.67+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4d71dce4-fd28-4028-9e67-3febcb98cae4', 'tenant-a2', NULL, 'tenant-a2-ext-7', 'utterance', '{"text": "tenant-a2 の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.678+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('4469cb10-1a12-4166-a8c0-be27fe5911cb', 'tenant-a2', NULL, 'tenant-a2-ext-8', 'utterance', '{"text": "tenant-a2 の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-10-07 19:12:50.682+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('a0ba71ba-b950-42db-b53e-d05021c0fa9b', 'tenant-a2', NULL, 'tenant-a2-ext-9', 'utterance', '{"text": "tenant-a2 の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-10-07 19:12:50.688+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b27d6493-8c52-4f5f-a2a4-8e339ef3da4f', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-10-07 19:12:50.692+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('3a7b4253-481f-472f-962b-d6380095ff1a', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 0", "speaker": "user"}', NULL, '2026-10-07 19:12:50.736+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('b4eb8c6a-c617-4ba7-8e8f-ad17163e20a8', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 1", "speaker": "user"}', NULL, '2026-10-07 19:12:50.741+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('e5f26b59-5901-4593-8ab4-00afdba5a24e', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 2", "speaker": "user"}', NULL, '2026-10-07 19:12:50.748+09', NULL, NULL, '{}');
INSERT INTO public.observations VALUES ('13c468dd-9926-4110-8a0d-517eceb934d4', 'tenant-a2', NULL, NULL, 'usage', '{"recallId": "343354ae-8301-446d-9d0c-5669f33ace5e", "usedMemoryIds": ["deeae107-b83d-4965-8898-04e20b6c725f"]}', NULL, '2026-10-07 19:12:50.779+09', NULL, NULL, '{}');


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.outbox VALUES ('71c3a1f4-071a-4768-9171-09dbf9a201c4', 'tenant-a', 'extract', '{"observationId": "f2bd800e-ae1d-4142-8a33-90d6d0d5fb5b"}', '2026-10-07 19:12:49.686+09', '2026-10-07 19:12:49.686+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.701+09', NULL, NULL, '2026-10-07 19:12:49.686+09');
INSERT INTO public.outbox VALUES ('873fce3f-444a-423c-9d2f-a0732246fb33', 'tenant-a', 'extract', '{"observationId": "dac5d34f-27b5-4774-b69c-a52741f102ca"}', '2026-10-07 19:12:49.703+09', '2026-10-07 19:12:49.703+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.71+09', NULL, NULL, '2026-10-07 19:12:49.703+09');
INSERT INTO public.outbox VALUES ('b59ae904-e1a6-44d0-a4b9-0abff107e145', 'tenant-a', 'extract', '{"observationId": "1d97b1ed-265d-4058-b69d-896f3400ef77"}', '2026-10-07 19:12:49.711+09', '2026-10-07 19:12:49.711+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.716+09', NULL, NULL, '2026-10-07 19:12:49.711+09');
INSERT INTO public.outbox VALUES ('f0beccb6-a9d7-4ebc-8459-3c69daf18068', 'tenant-a', 'extract', '{"observationId": "03b945b2-3004-4ec2-822d-2087c5a606ac"}', '2026-10-07 19:12:49.716+09', '2026-10-07 19:12:49.716+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.723+09', NULL, NULL, '2026-10-07 19:12:49.716+09');
INSERT INTO public.outbox VALUES ('3d12df79-5ced-451e-8932-fc342345d65f', 'tenant-a', 'extract', '{"observationId": "90d5e4f0-7a20-4744-b8e5-5435b5e2c8a4"}', '2026-10-07 19:12:49.724+09', '2026-10-07 19:12:49.724+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.731+09', NULL, NULL, '2026-10-07 19:12:49.724+09');
INSERT INTO public.outbox VALUES ('857abf61-6c11-499b-8790-efcc961b2c3b', 'tenant-a', 'extract', '{"observationId": "ca0c0a6a-8787-448c-acdc-cd7f3454e2eb"}', '2026-10-07 19:12:49.731+09', '2026-10-07 19:12:49.731+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.737+09', NULL, NULL, '2026-10-07 19:12:49.731+09');
INSERT INTO public.outbox VALUES ('0740cb28-6fb5-4335-a756-2216c9dfe8ac', 'tenant-a', 'extract', '{"observationId": "5f1af2a1-5bf8-4e9b-a467-51ea0a572373"}', '2026-10-07 19:12:49.737+09', '2026-10-07 19:12:49.737+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.742+09', NULL, NULL, '2026-10-07 19:12:49.737+09');
INSERT INTO public.outbox VALUES ('c2ddefc7-9ce3-4fc1-80c9-6551c4fd159c', 'tenant-a', 'extract', '{"observationId": "6d1f2115-b891-4b08-b19f-c0f99080b7ee"}', '2026-10-07 19:12:49.743+09', '2026-10-07 19:12:49.743+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.752+09', NULL, NULL, '2026-10-07 19:12:49.743+09');
INSERT INTO public.outbox VALUES ('f7e15125-8c4e-45b4-be99-a547d69d8861', 'tenant-a', 'extract', '{"observationId": "05b46abb-f32c-448f-8377-a1772ecca1e0"}', '2026-10-07 19:12:49.753+09', '2026-10-07 19:12:49.753+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.764+09', NULL, NULL, '2026-10-07 19:12:49.753+09');
INSERT INTO public.outbox VALUES ('a93aa491-0513-490d-bffd-bdc488a95ec6', 'tenant-a', 'extract', '{"observationId": "cb13c0ff-5e59-4417-b044-e07bf66b005e"}', '2026-10-07 19:12:49.764+09', '2026-10-07 19:12:49.764+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.77+09', NULL, NULL, '2026-10-07 19:12:49.764+09');
INSERT INTO public.outbox VALUES ('555a1d96-ae0c-42b6-be3f-e86022671a12', 'tenant-a', 'extract', '{"observationId": "9da33a21-616e-418f-9bb2-9073ed702339"}', '2026-10-07 19:12:49.771+09', '2026-10-07 19:12:49.771+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.777+09', NULL, NULL, '2026-10-07 19:12:49.771+09');
INSERT INTO public.outbox VALUES ('59b37f6c-d294-4a85-a890-da576811b33b', 'tenant-a', 'extract', '{"observationId": "7dec288f-9ddc-4555-8903-1915bd4facf6"}', '2026-10-07 19:12:49.778+09', '2026-10-07 19:12:49.778+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.785+09', NULL, NULL, '2026-10-07 19:12:49.778+09');
INSERT INTO public.outbox VALUES ('35fe4e38-43a4-44d4-903b-8c451eb5abbb', 'tenant-a', 'extract', '{"observationId": "b923926d-5979-4f0c-908b-8fbc8b4d045f"}', '2026-10-07 19:12:49.785+09', '2026-10-07 19:12:49.785+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.79+09', NULL, NULL, '2026-10-07 19:12:49.785+09');
INSERT INTO public.outbox VALUES ('074dfe9b-e094-43af-b9da-213ff5493aa3', 'tenant-a', 'extract', '{"observationId": "2c29aa5b-12ed-4fed-93dc-073814b6be56"}', '2026-10-07 19:12:49.791+09', '2026-10-07 19:12:49.791+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.797+09', NULL, NULL, '2026-10-07 19:12:49.791+09');
INSERT INTO public.outbox VALUES ('4c2fc1b9-5cb2-4bf2-afb5-a05bd6f63258', 'tenant-a', 'extract', '{"observationId": "60448c08-b265-48eb-89f6-a329bd2ddd82"}', '2026-10-07 19:12:49.797+09', '2026-10-07 19:12:49.797+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.802+09', NULL, NULL, '2026-10-07 19:12:49.797+09');
INSERT INTO public.outbox VALUES ('51ee6a77-44a0-4c6d-9d0a-6636d4f8ca30', 'tenant-a', 'extract', '{"observationId": "4ff42bf6-a836-47d1-bddc-22eba530577d"}', '2026-10-07 19:12:49.803+09', '2026-10-07 19:12:49.803+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.809+09', NULL, NULL, '2026-10-07 19:12:49.803+09');
INSERT INTO public.outbox VALUES ('5b19166e-d0c0-41d1-8870-eb9f970abddc', 'tenant-a', 'extract', '{"observationId": "9abda3c3-8a4b-4add-8cec-e2c8e600466b"}', '2026-10-07 19:12:49.809+09', '2026-10-07 19:12:49.809+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.814+09', NULL, NULL, '2026-10-07 19:12:49.809+09');
INSERT INTO public.outbox VALUES ('fb8a7569-4e56-45a8-a794-d912978ce0d1', 'tenant-a', 'extract', '{"observationId": "86c53a97-ffa0-4c99-9370-93bac1c93e88"}', '2026-10-07 19:12:49.815+09', '2026-10-07 19:12:49.815+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.819+09', NULL, NULL, '2026-10-07 19:12:49.815+09');
INSERT INTO public.outbox VALUES ('319cce27-0019-44b5-ab1c-d59037af56ae', 'tenant-a', 'extract', '{"observationId": "dafa8d14-afaa-483e-989a-bb426bfb34c0"}', '2026-10-07 19:12:49.82+09', '2026-10-07 19:12:49.82+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.825+09', NULL, NULL, '2026-10-07 19:12:49.82+09');
INSERT INTO public.outbox VALUES ('945db5ed-032f-42e4-b685-19188c82a29a', 'tenant-a', 'extract', '{"observationId": "753c6226-0436-4ac9-9792-c2380330b295"}', '2026-10-07 19:12:49.826+09', '2026-10-07 19:12:49.826+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.831+09', NULL, NULL, '2026-10-07 19:12:49.826+09');
INSERT INTO public.outbox VALUES ('fb6dae26-6088-4e60-9a88-cf521467e56e', 'tenant-a', 'extract', '{"observationId": "fa90f474-0d99-43a0-9567-db3c096ab749"}', '2026-10-07 19:12:49.831+09', '2026-10-07 19:12:49.831+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.836+09', NULL, NULL, '2026-10-07 19:12:49.831+09');
INSERT INTO public.outbox VALUES ('723e8c82-1f63-4c19-b126-16dd0c52bdfe', 'tenant-a', 'extract', '{"observationId": "54069544-b88c-4a20-b8f9-3079df03663a"}', '2026-10-07 19:12:49.837+09', '2026-10-07 19:12:49.837+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.842+09', NULL, NULL, '2026-10-07 19:12:49.837+09');
INSERT INTO public.outbox VALUES ('c095f42a-c6b7-407f-8533-6170f021b9f8', 'tenant-a', 'extract', '{"observationId": "134c45fd-6b42-4bd1-910e-74023fc45912"}', '2026-10-07 19:12:49.843+09', '2026-10-07 19:12:49.843+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.851+09', NULL, NULL, '2026-10-07 19:12:49.843+09');
INSERT INTO public.outbox VALUES ('23154481-405d-4899-90cc-07df49225f11', 'tenant-a', 'embed', '{"memoryId": "32b68e43-7607-43ce-968b-0b780cfe4245"}', '2026-10-07 19:12:49.694+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.87+09', NULL, NULL, '2026-10-07 19:12:49.694+09');
INSERT INTO public.outbox VALUES ('f390a1a1-9238-4d89-abfe-a486ac7cdcbe', 'tenant-a', 'extract', '{"observationId": "b5107091-31f8-4a6c-b62d-af7da5d02e56"}', '2026-10-07 19:12:49.852+09', '2026-10-07 19:12:49.852+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.857+09', NULL, NULL, '2026-10-07 19:12:49.852+09');
INSERT INTO public.outbox VALUES ('bb1b79be-7bd3-45c9-8e1f-ecf22b97963e', 'tenant-a', 'extract', '{"observationId": "7f6c3d77-33c2-4c43-b620-578e18912b20"}', '2026-10-07 19:12:49.858+09', '2026-10-07 19:12:49.858+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.862+09', NULL, NULL, '2026-10-07 19:12:49.858+09');
INSERT INTO public.outbox VALUES ('d36970bd-29dc-492f-baf7-165939bc8975', 'tenant-a', 'embed', '{"memoryId": "9da74c9a-e84e-4c92-9403-a9644ddfc4e2"}', '2026-10-07 19:12:49.707+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.873+09', NULL, NULL, '2026-10-07 19:12:49.707+09');
INSERT INTO public.outbox VALUES ('d4bc5843-53d8-426b-a8e8-a0a2891cdadf', 'tenant-a', 'embed', '{"memoryId": "30fc99e8-5f10-4be6-8010-b10d910ce337"}', '2026-10-07 19:12:49.713+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.876+09', NULL, NULL, '2026-10-07 19:12:49.713+09');
INSERT INTO public.outbox VALUES ('cc7e9e44-9e0c-49ec-b438-196695df7dac', 'tenant-a', 'embed', '{"memoryId": "6125525a-ae5f-4bdf-8cca-a625c29ca568"}', '2026-10-07 19:12:49.718+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.881+09', NULL, NULL, '2026-10-07 19:12:49.718+09');
INSERT INTO public.outbox VALUES ('4fabdd60-9269-4cf3-9590-63109fd87eda', 'tenant-a', 'embed', '{"memoryId": "127c9455-d0f5-4d78-bcc2-ff1fda91b591"}', '2026-10-07 19:12:49.727+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.886+09', NULL, NULL, '2026-10-07 19:12:49.727+09');
INSERT INTO public.outbox VALUES ('40a5a73a-d41c-487b-8d09-773271ec8d5c', 'tenant-a', 'embed', '{"memoryId": "94f35c86-e0c2-4754-849c-68bb1d35bcb7"}', '2026-10-07 19:12:49.734+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.891+09', NULL, NULL, '2026-10-07 19:12:49.734+09');
INSERT INTO public.outbox VALUES ('0664516e-bcf9-4e0b-b8b0-68ca7c046389', 'tenant-a', 'embed', '{"memoryId": "d0cc5de2-ea0c-475c-bb6a-0a89874cbede"}', '2026-10-07 19:12:49.739+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.894+09', NULL, NULL, '2026-10-07 19:12:49.739+09');
INSERT INTO public.outbox VALUES ('dee49765-f4b3-43d0-9980-931bce4745e4', 'tenant-a', 'embed', '{"memoryId": "d75349ca-82d1-417a-a673-858338419917"}', '2026-10-07 19:12:49.747+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.898+09', NULL, NULL, '2026-10-07 19:12:49.747+09');
INSERT INTO public.outbox VALUES ('497af72d-333c-49a5-8937-885edd9216e4', 'tenant-a', 'embed', '{"memoryId": "05371d53-f656-469d-be70-9f30b9ea4c0c"}', '2026-10-07 19:12:49.756+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.901+09', NULL, NULL, '2026-10-07 19:12:49.756+09');
INSERT INTO public.outbox VALUES ('9ca9c80f-67ee-46f2-977e-d09da6783494', 'tenant-a', 'embed', '{"memoryId": "16eadbc1-1bf8-4efa-8a2f-a64d0d567134"}', '2026-10-07 19:12:49.767+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.906+09', NULL, NULL, '2026-10-07 19:12:49.767+09');
INSERT INTO public.outbox VALUES ('cf688a9f-8f83-4b9a-830f-d9c9f3f7a1d9', 'tenant-a', 'embed', '{"memoryId": "d9549aaa-52dd-473d-b1b9-05b29f1f821b"}', '2026-10-07 19:12:49.774+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.909+09', NULL, NULL, '2026-10-07 19:12:49.774+09');
INSERT INTO public.outbox VALUES ('9cc5754d-5e89-47d7-ab46-be2e32ea59cb', 'tenant-a', 'embed', '{"memoryId": "c60f211d-5c6f-4945-8a2d-dac179267962"}', '2026-10-07 19:12:49.781+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.912+09', NULL, NULL, '2026-10-07 19:12:49.781+09');
INSERT INTO public.outbox VALUES ('29ab3d32-3925-4a4f-b5ea-6b9791068f40', 'tenant-a', 'embed', '{"memoryId": "95565971-61a9-48d4-8bf0-6146c1b18ab4"}', '2026-10-07 19:12:49.788+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.916+09', NULL, NULL, '2026-10-07 19:12:49.788+09');
INSERT INTO public.outbox VALUES ('ac8441cc-6b00-4e9d-b942-28aebb2552d9', 'tenant-a', 'embed', '{"memoryId": "e385d8b3-b308-4c04-906c-e9df8b7efb5b"}', '2026-10-07 19:12:49.793+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.919+09', NULL, NULL, '2026-10-07 19:12:49.793+09');
INSERT INTO public.outbox VALUES ('b554ffa9-5b95-47bc-b0ae-bbd9bf2968bc', 'tenant-a', 'embed', '{"memoryId": "8e77776f-9fac-490a-a360-03f046b63b21"}', '2026-10-07 19:12:49.8+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.923+09', NULL, NULL, '2026-10-07 19:12:49.8+09');
INSERT INTO public.outbox VALUES ('b36c58e3-824d-4a7a-85e3-896e7e4abcfa', 'tenant-a', 'embed', '{"memoryId": "45289fa9-c141-49e8-aa27-403947904678"}', '2026-10-07 19:12:49.806+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.926+09', NULL, NULL, '2026-10-07 19:12:49.806+09');
INSERT INTO public.outbox VALUES ('056c81f8-7708-48a9-8e3f-80161b062db5', 'tenant-a', 'embed', '{"memoryId": "8dc7ffd1-b4c8-4396-944e-cc8905b390f2"}', '2026-10-07 19:12:49.812+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.929+09', NULL, NULL, '2026-10-07 19:12:49.812+09');
INSERT INTO public.outbox VALUES ('b4cb5f4e-5b64-4cbb-bd62-750315d3bcc6', 'tenant-a', 'embed', '{"memoryId": "96b496be-f3f0-4cea-aaa4-6ca6469d2514"}', '2026-10-07 19:12:49.817+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.932+09', NULL, NULL, '2026-10-07 19:12:49.817+09');
INSERT INTO public.outbox VALUES ('5e1ea03e-4e4a-4bc5-8e68-108eb5c11a34', 'tenant-a', 'embed', '{"memoryId": "d83a8a10-71ac-47f7-98cd-866c2109058f"}', '2026-10-07 19:12:49.822+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.935+09', NULL, NULL, '2026-10-07 19:12:49.822+09');
INSERT INTO public.outbox VALUES ('f75883e2-2435-48cd-a65f-4ffd8c5ddc79', 'tenant-a', 'embed', '{"memoryId": "c32a3934-086f-4808-b9f8-bf1d05d13413"}', '2026-10-07 19:12:49.828+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.937+09', NULL, NULL, '2026-10-07 19:12:49.828+09');
INSERT INTO public.outbox VALUES ('bc585c16-c1b7-4c64-83d2-7b310f343d8c', 'tenant-a', 'embed', '{"memoryId": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}', '2026-10-07 19:12:49.833+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.941+09', NULL, NULL, '2026-10-07 19:12:49.833+09');
INSERT INTO public.outbox VALUES ('4b50599a-bb10-4e6d-9430-8bc193756eeb', 'tenant-a', 'embed', '{"memoryId": "c60d04c8-7f18-40ac-b425-117dcad2b9c4"}', '2026-10-07 19:12:49.839+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.947+09', NULL, NULL, '2026-10-07 19:12:49.839+09');
INSERT INTO public.outbox VALUES ('817d3f89-60b7-4ec8-8d7d-653a251bdec3', 'tenant-a', 'embed', '{"memoryId": "165a96af-6587-4299-a87a-b08c581ccf0c"}', '2026-10-07 19:12:49.848+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.952+09', NULL, NULL, '2026-10-07 19:12:49.848+09');
INSERT INTO public.outbox VALUES ('42047e2d-75d8-4f62-9c31-28bc2310d240', 'tenant-a', 'embed', '{"memoryId": "1031045a-5312-41df-aa4f-cbeb244c9676"}', '2026-10-07 19:12:49.854+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, '2026-10-07 19:12:49.956+09', NULL, NULL, '2026-10-07 19:12:49.854+09');
INSERT INTO public.outbox VALUES ('1127302b-9531-4392-9f63-7b53b2b5cc32', 'tenant-a', 'embed', '{"memoryId": "ca48985b-a8be-472d-b44d-66f9f27d7427"}', '2026-10-07 19:12:49.859+09', '2026-10-07 19:12:49.863+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:49.965+09', 'fixture: embedding provider failure', '2026-10-07 19:12:49.859+09');
INSERT INTO public.outbox VALUES ('94e29759-1c7b-45bd-9d4a-fa1c745cf71c', 'tenant-a', 'embed', '{"memoryId": "f56e4e56-18b6-4be9-8635-66f70bf99079"}', '2026-10-07 19:12:49.969+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:49.969+09');
INSERT INTO public.outbox VALUES ('0800f6c7-f1db-44b9-84aa-84b64ee4d239', 'tenant-a', 'extract', '{"observationId": "0655d0e4-5d79-41ba-9465-b97319b9d042"}', '2026-10-07 19:12:49.967+09', '2026-10-07 19:12:49.967+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.976+09', NULL, NULL, '2026-10-07 19:12:49.967+09');
INSERT INTO public.outbox VALUES ('e6719e4f-8ed4-4efc-9c6e-039c02660622', 'tenant-a', 'embed', '{"memoryId": "f113ce19-c359-4019-821e-36a0783e9a4b"}', '2026-10-07 19:12:49.979+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:49.979+09');
INSERT INTO public.outbox VALUES ('c04fd681-171c-48a2-9402-59ad2a372440', 'tenant-a', 'extract', '{"observationId": "9d404363-788e-4264-9a7e-81c2bf2467f7"}', '2026-10-07 19:12:49.977+09', '2026-10-07 19:12:49.977+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.982+09', NULL, NULL, '2026-10-07 19:12:49.977+09');
INSERT INTO public.outbox VALUES ('3824f348-701c-46d0-a624-4ac0fb82937e', 'tenant-a', 'embed', '{"memoryId": "f0e54766-eb5b-4750-a41b-e686eeaf8a26"}', '2026-10-07 19:12:49.984+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:49.984+09');
INSERT INTO public.outbox VALUES ('f18f3b7b-a71e-4310-847e-bfc11ae40d97', 'tenant-a', 'extract', '{"observationId": "0b36b7d3-04d0-4e9c-bc51-003718185601"}', '2026-10-07 19:12:49.982+09', '2026-10-07 19:12:49.982+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:49.988+09', NULL, NULL, '2026-10-07 19:12:49.982+09');
INSERT INTO public.outbox VALUES ('b89965fb-c13c-4001-a5ff-3b90dd5783c4', 'tenant-b', 'extract', '{"observationId": "41a79a3b-3a5c-4f9e-8c57-3609e7b5d956"}', '2026-10-07 19:12:50.058+09', '2026-10-07 19:12:50.058+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.063+09', NULL, NULL, '2026-10-07 19:12:50.058+09');
INSERT INTO public.outbox VALUES ('471ad5c6-fbe1-46cd-87d5-2310f8007e4c', 'tenant-b', 'extract', '{"observationId": "e4d4e135-8244-4842-9612-80c15733c9a8"}', '2026-10-07 19:12:50.064+09', '2026-10-07 19:12:50.064+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.07+09', NULL, NULL, '2026-10-07 19:12:50.064+09');
INSERT INTO public.outbox VALUES ('900ebc21-7928-4fe0-8aea-adaa2b9bad4b', 'tenant-b', 'extract', '{"observationId": "700eee08-7d19-4b94-842f-ae4a5e65172b"}', '2026-10-07 19:12:50.071+09', '2026-10-07 19:12:50.071+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.075+09', NULL, NULL, '2026-10-07 19:12:50.071+09');
INSERT INTO public.outbox VALUES ('a8709765-98fe-4940-9624-b86813faee3b', 'tenant-b', 'extract', '{"observationId": "384999c2-aec2-40a2-87e9-0193d4ff3d80"}', '2026-10-07 19:12:50.076+09', '2026-10-07 19:12:50.076+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.081+09', NULL, NULL, '2026-10-07 19:12:50.076+09');
INSERT INTO public.outbox VALUES ('cb6f6c2e-b7e7-45f9-9931-18943fc4bf06', 'tenant-b', 'extract', '{"observationId": "9071431d-f893-4ebc-840f-07f2458c560d"}', '2026-10-07 19:12:50.081+09', '2026-10-07 19:12:50.081+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.089+09', NULL, NULL, '2026-10-07 19:12:50.081+09');
INSERT INTO public.outbox VALUES ('e5e83fe1-e698-42de-866f-a4c5d4133ecc', 'tenant-b', 'extract', '{"observationId": "fa148901-c42b-487f-a30c-b697500af4e6"}', '2026-10-07 19:12:50.089+09', '2026-10-07 19:12:50.089+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.094+09', NULL, NULL, '2026-10-07 19:12:50.089+09');
INSERT INTO public.outbox VALUES ('4b58af7a-1d54-46ff-bb1b-8bea981d9a8f', 'tenant-b', 'embed', '{"memoryId": "3f2ddb6d-3ebb-4f2c-b820-967569432b05"}', '2026-10-07 19:12:50.06+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.195+09', NULL, NULL, '2026-10-07 19:12:50.06+09');
INSERT INTO public.outbox VALUES ('8f5712f8-c45a-4ede-a54b-d089bd12c391', 'tenant-b', 'extract', '{"observationId": "57ee7bf1-8d9c-464d-9a41-3c4a9af16503"}', '2026-10-07 19:12:50.095+09', '2026-10-07 19:12:50.095+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.102+09', NULL, NULL, '2026-10-07 19:12:50.095+09');
INSERT INTO public.outbox VALUES ('b65b0733-f6de-434e-b281-dcb5650e1ada', 'tenant-b', 'extract', '{"observationId": "1f865044-7d5e-4722-bd18-58feb9b30523"}', '2026-10-07 19:12:50.103+09', '2026-10-07 19:12:50.103+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.108+09', NULL, NULL, '2026-10-07 19:12:50.103+09');
INSERT INTO public.outbox VALUES ('fb5a256f-6411-4bdb-a997-fa61ad2b57e8', 'tenant-b', 'extract', '{"observationId": "3efd4a19-d1a2-43db-b154-c9236dc62928"}', '2026-10-07 19:12:50.109+09', '2026-10-07 19:12:50.109+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.113+09', NULL, NULL, '2026-10-07 19:12:50.109+09');
INSERT INTO public.outbox VALUES ('86281cc4-bec7-4694-96b0-eef9b9788907', 'tenant-b', 'extract', '{"observationId": "87f3be43-77d7-4421-9944-d968e75e3a5f"}', '2026-10-07 19:12:50.114+09', '2026-10-07 19:12:50.114+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.118+09', NULL, NULL, '2026-10-07 19:12:50.114+09');
INSERT INTO public.outbox VALUES ('e2ce88e8-ed29-4884-bf6a-1029f6ed2a4b', 'tenant-b', 'extract', '{"observationId": "b4815f90-b361-49de-a947-a8192d20e60e"}', '2026-10-07 19:12:50.118+09', '2026-10-07 19:12:50.118+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.122+09', NULL, NULL, '2026-10-07 19:12:50.118+09');
INSERT INTO public.outbox VALUES ('79d15e54-0093-45b8-b669-09d253e8ac1d', 'tenant-b', 'extract', '{"observationId": "da4cf9f6-8876-4019-8c8e-e631ffedfa30"}', '2026-10-07 19:12:50.122+09', '2026-10-07 19:12:50.122+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.126+09', NULL, NULL, '2026-10-07 19:12:50.122+09');
INSERT INTO public.outbox VALUES ('eec81b09-24b5-45dd-8a7f-d98dbd69cffb', 'tenant-b', 'extract', '{"observationId": "b7a63156-f81c-48d9-83e4-351e056bc938"}', '2026-10-07 19:12:50.127+09', '2026-10-07 19:12:50.127+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.13+09', NULL, NULL, '2026-10-07 19:12:50.127+09');
INSERT INTO public.outbox VALUES ('bdc85ce2-b33d-4b93-8dd0-723d37beb644', 'tenant-b', 'extract', '{"observationId": "86ca5159-500b-484c-b1d0-5076b69a1133"}', '2026-10-07 19:12:50.131+09', '2026-10-07 19:12:50.131+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.136+09', NULL, NULL, '2026-10-07 19:12:50.131+09');
INSERT INTO public.outbox VALUES ('9e1ab90e-79ef-47e6-967f-24ebf1320117', 'tenant-b', 'extract', '{"observationId": "1f53c121-022c-4a25-96ac-fd59e6c8fd20"}', '2026-10-07 19:12:50.137+09', '2026-10-07 19:12:50.137+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.141+09', NULL, NULL, '2026-10-07 19:12:50.137+09');
INSERT INTO public.outbox VALUES ('f1d2446b-dcf7-4c1b-aaf9-5321c3d1903c', 'tenant-b', 'extract', '{"observationId": "6d0a052c-12b8-4d0e-93bf-b414bf92a753"}', '2026-10-07 19:12:50.142+09', '2026-10-07 19:12:50.142+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.15+09', NULL, NULL, '2026-10-07 19:12:50.142+09');
INSERT INTO public.outbox VALUES ('c353845e-ed77-496b-85d7-6a2687b329a6', 'tenant-b', 'extract', '{"observationId": "1a84ab64-d393-4c5a-adba-128c463e7473"}', '2026-10-07 19:12:50.157+09', '2026-10-07 19:12:50.157+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.175+09', NULL, NULL, '2026-10-07 19:12:50.157+09');
INSERT INTO public.outbox VALUES ('ffa9b692-08b9-44ab-a5bd-edc1ba78a5c7', 'tenant-b', 'extract', '{"observationId": "d7b83ff4-5468-41b8-80bb-eb60914e1c6c"}', '2026-10-07 19:12:50.175+09', '2026-10-07 19:12:50.175+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.181+09', NULL, NULL, '2026-10-07 19:12:50.175+09');
INSERT INTO public.outbox VALUES ('864ff6fd-c983-49fc-9b4d-aedb203ea2fd', 'tenant-b', 'extract', '{"observationId": "7a20e5aa-b947-4a07-af13-25b2c7ab7300"}', '2026-10-07 19:12:50.182+09', '2026-10-07 19:12:50.182+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.186+09', NULL, NULL, '2026-10-07 19:12:50.182+09');
INSERT INTO public.outbox VALUES ('681c16c1-b16e-4f0d-8f59-815a8500d7bb', 'tenant-b', 'embed', '{"memoryId": "0ec8e879-c4d6-448c-9751-1857aec8159e"}', '2026-10-07 19:12:50.067+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.199+09', NULL, NULL, '2026-10-07 19:12:50.067+09');
INSERT INTO public.outbox VALUES ('2cb8da5d-7c29-414e-8320-7809b435639b', 'tenant-b', 'embed', '{"memoryId": "e8d5424f-0a9a-451e-9f14-77d672705c70"}', '2026-10-07 19:12:50.073+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.202+09', NULL, NULL, '2026-10-07 19:12:50.073+09');
INSERT INTO public.outbox VALUES ('64511e1a-1b3c-4e5b-be0c-7d6ed701628a', 'tenant-b', 'embed', '{"memoryId": "263bb4c9-6752-4889-ae08-5a96e72c4902"}', '2026-10-07 19:12:50.078+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.217+09', NULL, NULL, '2026-10-07 19:12:50.078+09');
INSERT INTO public.outbox VALUES ('85c136d7-0cbd-40ee-a3c5-6e4ad33f0291', 'tenant-b', 'embed', '{"memoryId": "ecdef4b9-eb0c-41db-8c13-da58f544686a"}', '2026-10-07 19:12:50.084+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.227+09', NULL, NULL, '2026-10-07 19:12:50.084+09');
INSERT INTO public.outbox VALUES ('85b37651-f493-45d5-a1b8-386aa0ff8686', 'tenant-b', 'embed', '{"memoryId": "5cab23bf-8349-4f08-82c4-fcc05b183999"}', '2026-10-07 19:12:50.092+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.238+09', NULL, NULL, '2026-10-07 19:12:50.092+09');
INSERT INTO public.outbox VALUES ('5eb55580-c9b4-44ad-945f-de69439a40da', 'tenant-b', 'embed', '{"memoryId": "84d27a31-017c-4d50-b5b2-23a5bfb747c1"}', '2026-10-07 19:12:50.098+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.252+09', NULL, NULL, '2026-10-07 19:12:50.098+09');
INSERT INTO public.outbox VALUES ('0ffd9a58-5d51-4756-97da-d7f452d446ae', 'tenant-b', 'embed', '{"memoryId": "9b1fa9a7-1d68-4d06-82b7-029b5e425d28"}', '2026-10-07 19:12:50.105+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.258+09', NULL, NULL, '2026-10-07 19:12:50.105+09');
INSERT INTO public.outbox VALUES ('1642deee-9000-49a9-b8b2-2ceabd91cbc5', 'tenant-b', 'embed', '{"memoryId": "e75d25a6-e93e-4982-af68-f44c408aa00e"}', '2026-10-07 19:12:50.111+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.262+09', NULL, NULL, '2026-10-07 19:12:50.111+09');
INSERT INTO public.outbox VALUES ('880a3cb4-40f1-4c5d-b0e8-3369aa002aa4', 'tenant-b', 'embed', '{"memoryId": "2904e9a5-cd88-4985-b9b9-95798047b0c3"}', '2026-10-07 19:12:50.115+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.266+09', NULL, NULL, '2026-10-07 19:12:50.115+09');
INSERT INTO public.outbox VALUES ('f9126c74-dffb-4805-bb93-58a81ffb6cc7', 'tenant-b', 'embed', '{"memoryId": "ac6d95fd-7cb6-4f01-b633-9a5bc2bf5e05"}', '2026-10-07 19:12:50.12+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.269+09', NULL, NULL, '2026-10-07 19:12:50.12+09');
INSERT INTO public.outbox VALUES ('9c162c83-6c7a-4cfc-b0ae-d05200931845', 'tenant-b', 'embed', '{"memoryId": "5bf76290-e5e2-4fa4-bd2f-2737ef5578c8"}', '2026-10-07 19:12:50.124+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.272+09', NULL, NULL, '2026-10-07 19:12:50.124+09');
INSERT INTO public.outbox VALUES ('728199ef-7e80-4642-a032-415922358313', 'tenant-b', 'embed', '{"memoryId": "b01b630d-8c27-43b0-934a-759588d7f954"}', '2026-10-07 19:12:50.128+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.275+09', NULL, NULL, '2026-10-07 19:12:50.128+09');
INSERT INTO public.outbox VALUES ('8a9c3b89-fb60-4a81-ac64-b4cfca61ba28', 'tenant-b', 'embed', '{"memoryId": "453b883d-1d64-4397-b6bd-f9b42c4d9a52"}', '2026-10-07 19:12:50.133+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.278+09', NULL, NULL, '2026-10-07 19:12:50.133+09');
INSERT INTO public.outbox VALUES ('fd4f14eb-dbdc-4889-91d4-6ac32aa0822f', 'tenant-b', 'embed', '{"memoryId": "6233d0ba-3289-4b18-bf47-3ad3afd3c613"}', '2026-10-07 19:12:50.139+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.28+09', NULL, NULL, '2026-10-07 19:12:50.139+09');
INSERT INTO public.outbox VALUES ('a108838a-9b83-454f-9dab-5ac3b4cf0f0f', 'tenant-b', 'embed', '{"memoryId": "fc49847e-02c0-4b33-a5fb-f4cb7bd4ebb5"}', '2026-10-07 19:12:50.144+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.283+09', NULL, NULL, '2026-10-07 19:12:50.144+09');
INSERT INTO public.outbox VALUES ('70375f47-1b5e-4613-9a0c-79416091c18f', 'tenant-b', 'embed', '{"memoryId": "e5987c84-2225-4e1c-8df0-59615e473121"}', '2026-10-07 19:12:50.17+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.287+09', NULL, NULL, '2026-10-07 19:12:50.17+09');
INSERT INTO public.outbox VALUES ('0b5c16bb-c2f9-40cc-805a-21d517cca725', 'tenant-b', 'embed', '{"memoryId": "cd3efb23-07cb-490c-89d3-23195c957396"}', '2026-10-07 19:12:50.178+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, '2026-10-07 19:12:50.301+09', NULL, NULL, '2026-10-07 19:12:50.178+09');
INSERT INTO public.outbox VALUES ('4f77abcc-5ce8-4c36-addb-1eea49169ed5', 'tenant-b', 'embed', '{"memoryId": "60f0fac6-c743-4f0e-9a42-608e8c215244"}', '2026-10-07 19:12:50.184+09', '2026-10-07 19:12:50.187+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:50.307+09', 'fixture: embedding provider failure', '2026-10-07 19:12:50.184+09');
INSERT INTO public.outbox VALUES ('7912c7d2-f4e5-4ef8-9c34-04b44b1e06fd', 'tenant-b', 'embed', '{"memoryId": "b18db25c-08c7-4b7a-9646-95621eab1b91"}', '2026-10-07 19:12:50.312+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.312+09');
INSERT INTO public.outbox VALUES ('ce5b20ad-adaf-4a2f-b53f-31a72202c48d', 'tenant-b', 'extract', '{"observationId": "30d5c5c9-0d8f-4aef-8370-eafc26b9d325"}', '2026-10-07 19:12:50.309+09', '2026-10-07 19:12:50.309+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.318+09', NULL, NULL, '2026-10-07 19:12:50.309+09');
INSERT INTO public.outbox VALUES ('d2477fb1-9817-4dd6-8753-578d7adb4b22', 'tenant-b', 'embed', '{"memoryId": "8cae5ddc-4556-4e30-8110-48b3c11fcca8"}', '2026-10-07 19:12:50.325+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.325+09');
INSERT INTO public.outbox VALUES ('708fcfee-6e16-44b1-96d0-80071ba85f8f', 'tenant-b', 'extract', '{"observationId": "cb557362-bcdc-4808-809c-258a4d240831"}', '2026-10-07 19:12:50.319+09', '2026-10-07 19:12:50.319+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.329+09', NULL, NULL, '2026-10-07 19:12:50.319+09');
INSERT INTO public.outbox VALUES ('b9b77df3-fcab-4080-8b5a-c84c579598c6', 'tenant-b', 'embed', '{"memoryId": "b347bac9-0041-4d10-8a6c-10f4e9c75ebc"}', '2026-10-07 19:12:50.332+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.332+09');
INSERT INTO public.outbox VALUES ('e1cc4070-cd5c-4180-8f98-3be5eecd6f08', 'tenant-b', 'extract', '{"observationId": "d56da5ee-384a-4119-8805-dcc456b33cc3"}', '2026-10-07 19:12:50.33+09', '2026-10-07 19:12:50.33+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.335+09', NULL, NULL, '2026-10-07 19:12:50.33+09');
INSERT INTO public.outbox VALUES ('922f60f0-2463-404b-b567-b4c2e7fee0a2', 'tenant-c', 'extract', '{"observationId": "1ae14a1c-e686-4b53-a5d5-f4f1b5d3d77e"}', '2026-10-07 19:12:50.381+09', '2026-10-07 19:12:50.381+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.387+09', NULL, NULL, '2026-10-07 19:12:50.381+09');
INSERT INTO public.outbox VALUES ('154c7c80-9d48-4ce7-b146-b2a188ca08ce', 'tenant-c', 'extract', '{"observationId": "e58eb51c-71af-4c5c-b4fb-f1592d668364"}', '2026-10-07 19:12:50.388+09', '2026-10-07 19:12:50.388+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.393+09', NULL, NULL, '2026-10-07 19:12:50.388+09');
INSERT INTO public.outbox VALUES ('5cc53775-194e-4d10-bc85-6f9ace0143ab', 'tenant-c', 'extract', '{"observationId": "ff38eb67-753f-43ba-91cb-63faca683dcb"}', '2026-10-07 19:12:50.394+09', '2026-10-07 19:12:50.394+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.399+09', NULL, NULL, '2026-10-07 19:12:50.394+09');
INSERT INTO public.outbox VALUES ('6dd9605e-a362-4231-8fa7-660ebfde5cee', 'tenant-c', 'embed', '{"memoryId": "87b0af80-4a09-483a-8937-d7a8299cf069"}', '2026-10-07 19:12:50.384+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.471+09', NULL, NULL, '2026-10-07 19:12:50.384+09');
INSERT INTO public.outbox VALUES ('d9578f67-5a09-4814-bd82-c5b02ffe9710', 'tenant-c', 'extract', '{"observationId": "2e18df03-570a-45f3-a4ed-f30d97a31389"}', '2026-10-07 19:12:50.399+09', '2026-10-07 19:12:50.399+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.403+09', NULL, NULL, '2026-10-07 19:12:50.399+09');
INSERT INTO public.outbox VALUES ('b441aa27-d0de-4701-822d-4d43acc046df', 'tenant-c', 'extract', '{"observationId": "8f17ac01-21c0-49d8-a42c-4bc16c7a8f6b"}', '2026-10-07 19:12:50.405+09', '2026-10-07 19:12:50.405+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.41+09', NULL, NULL, '2026-10-07 19:12:50.405+09');
INSERT INTO public.outbox VALUES ('3df3c7ce-c4bf-4b45-87f1-d12007505cdd', 'tenant-c', 'extract', '{"observationId": "e4d3b447-6ec9-4e4e-951c-a316592bf919"}', '2026-10-07 19:12:50.41+09', '2026-10-07 19:12:50.41+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.415+09', NULL, NULL, '2026-10-07 19:12:50.41+09');
INSERT INTO public.outbox VALUES ('37253741-2e36-4ad5-86a0-93ea5f7b04fa', 'tenant-c', 'extract', '{"observationId": "14907a9d-bd37-4dc3-a51d-889192854951"}', '2026-10-07 19:12:50.416+09', '2026-10-07 19:12:50.416+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.421+09', NULL, NULL, '2026-10-07 19:12:50.416+09');
INSERT INTO public.outbox VALUES ('a6d59617-fbae-4ee0-81ed-fac4a9b54279', 'tenant-c', 'extract', '{"observationId": "76799240-dfd8-4ed7-a7c7-d519bca90498"}', '2026-10-07 19:12:50.421+09', '2026-10-07 19:12:50.421+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.427+09', NULL, NULL, '2026-10-07 19:12:50.421+09');
INSERT INTO public.outbox VALUES ('55ff0456-c028-4db9-bf4e-e17dff91dda3', 'tenant-c', 'extract', '{"observationId": "a883c6d3-eb8e-47b1-9561-16941ab56222"}', '2026-10-07 19:12:50.428+09', '2026-10-07 19:12:50.428+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.434+09', NULL, NULL, '2026-10-07 19:12:50.428+09');
INSERT INTO public.outbox VALUES ('6d6bdd94-8403-43c0-866e-7906536dca4b', 'tenant-c', 'extract', '{"observationId": "22e21955-e7e7-4944-ac09-377a1b29f8ac"}', '2026-10-07 19:12:50.435+09', '2026-10-07 19:12:50.435+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.443+09', NULL, NULL, '2026-10-07 19:12:50.435+09');
INSERT INTO public.outbox VALUES ('cbaf9c81-4be4-414b-914f-d5b601f5ef24', 'tenant-c', 'extract', '{"observationId": "e3244b2b-78bb-4f10-b1da-33828541e130"}', '2026-10-07 19:12:50.446+09', '2026-10-07 19:12:50.446+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.452+09', NULL, NULL, '2026-10-07 19:12:50.446+09');
INSERT INTO public.outbox VALUES ('da4f6d11-48c1-424d-bfbc-6362a16bdde2', 'tenant-c', 'extract', '{"observationId": "320caf3c-1695-4b28-bbe7-9bda8cb1cb06"}', '2026-10-07 19:12:50.452+09', '2026-10-07 19:12:50.452+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.457+09', NULL, NULL, '2026-10-07 19:12:50.452+09');
INSERT INTO public.outbox VALUES ('b4ca8925-1f55-4faf-a241-cf891a1c1fa4', 'tenant-c', 'extract', '{"observationId": "554085f8-e701-4e54-8cd4-e2fb1a646b71"}', '2026-10-07 19:12:50.458+09', '2026-10-07 19:12:50.458+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.465+09', NULL, NULL, '2026-10-07 19:12:50.458+09');
INSERT INTO public.outbox VALUES ('49d6510b-c80d-4281-b509-a0953fb59dab', 'tenant-c', 'embed', '{"memoryId": "a99765fb-053f-4be4-ae02-213c695e85ec"}', '2026-10-07 19:12:50.39+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.475+09', NULL, NULL, '2026-10-07 19:12:50.39+09');
INSERT INTO public.outbox VALUES ('c629e0b2-0eb8-409f-a109-dcdaf94da7db', 'tenant-c', 'embed', '{"memoryId": "953ed106-e95f-4366-8e11-65e7c7850739"}', '2026-10-07 19:12:50.396+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.478+09', NULL, NULL, '2026-10-07 19:12:50.396+09');
INSERT INTO public.outbox VALUES ('225c3915-21ff-440e-873b-0aa602c064aa', 'tenant-c', 'embed', '{"memoryId": "36b1914c-9a39-49c8-a1ca-0e7d9aba6101"}', '2026-10-07 19:12:50.401+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.481+09', NULL, NULL, '2026-10-07 19:12:50.401+09');
INSERT INTO public.outbox VALUES ('2d247b06-3724-40d1-a691-ec86510662d0', 'tenant-c', 'embed', '{"memoryId": "6804edb4-8c73-4b01-8f9b-cfde9abe14cc"}', '2026-10-07 19:12:50.407+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.485+09', NULL, NULL, '2026-10-07 19:12:50.407+09');
INSERT INTO public.outbox VALUES ('1fd66975-fc16-4c18-822b-29152f36458e', 'tenant-c', 'embed', '{"memoryId": "514f505c-2984-4887-ad28-bf84d58a22b2"}', '2026-10-07 19:12:50.413+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.488+09', NULL, NULL, '2026-10-07 19:12:50.413+09');
INSERT INTO public.outbox VALUES ('5a03a11b-ece2-470a-9875-4f9e06a2e1e4', 'tenant-c', 'embed', '{"memoryId": "5288b42a-c6a1-43ed-8586-d61148b7b554"}', '2026-10-07 19:12:50.418+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.491+09', NULL, NULL, '2026-10-07 19:12:50.418+09');
INSERT INTO public.outbox VALUES ('0ba46031-ab42-4f18-9aea-34b5df312911', 'tenant-c', 'embed', '{"memoryId": "3fd82bd2-eb5c-4ef0-b063-859fd53c4924"}', '2026-10-07 19:12:50.423+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.494+09', NULL, NULL, '2026-10-07 19:12:50.423+09');
INSERT INTO public.outbox VALUES ('f911bdda-cfad-484d-b6ae-7f32c6a016d9', 'tenant-c', 'embed', '{"memoryId": "294f74c8-caf3-43f9-b986-3b9fc00620ca"}', '2026-10-07 19:12:50.431+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.503+09', NULL, NULL, '2026-10-07 19:12:50.431+09');
INSERT INTO public.outbox VALUES ('fb03f87c-3e1e-4cd5-bba1-5ee6e5d1539a', 'tenant-c', 'embed', '{"memoryId": "fe4acc2c-fdaa-459f-8531-86f25bd8cec5"}', '2026-10-07 19:12:50.438+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.508+09', NULL, NULL, '2026-10-07 19:12:50.438+09');
INSERT INTO public.outbox VALUES ('8b6e31e8-a76e-45b1-827f-f45b2fb1d1f1', 'tenant-c', 'embed', '{"memoryId": "e73742eb-1914-4fcd-abf7-18acda3a8c38"}', '2026-10-07 19:12:50.448+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.513+09', NULL, NULL, '2026-10-07 19:12:50.448+09');
INSERT INTO public.outbox VALUES ('a5fa4574-a422-442e-a97b-e1bd2ce7f55e', 'tenant-c', 'embed', '{"memoryId": "14dc000d-49d1-452a-8e21-085af5345688"}', '2026-10-07 19:12:50.454+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, '2026-10-07 19:12:50.517+09', NULL, NULL, '2026-10-07 19:12:50.454+09');
INSERT INTO public.outbox VALUES ('5188ab88-4bdf-400f-aff9-c6de13d8d501', 'tenant-c', 'embed', '{"memoryId": "c1e8190f-a6d8-4534-bcfd-318832da049a"}', '2026-10-07 19:12:50.46+09', '2026-10-07 19:12:50.466+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:50.52+09', 'fixture: embedding provider failure', '2026-10-07 19:12:50.46+09');
INSERT INTO public.outbox VALUES ('a8e5fa1d-15be-46d9-9a0e-1c08d48a327f', 'tenant-c', 'embed', '{"memoryId": "7feac528-333d-4360-85af-c2e8303b98fb"}', '2026-10-07 19:12:50.533+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.533+09');
INSERT INTO public.outbox VALUES ('a36c81c6-8c8e-4a2b-a6c3-aa6a2518191a', 'tenant-c', 'extract', '{"observationId": "c4727d49-6035-4046-9f31-05f9bc6df1b1"}', '2026-10-07 19:12:50.523+09', '2026-10-07 19:12:50.523+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.578+09', NULL, NULL, '2026-10-07 19:12:50.523+09');
INSERT INTO public.outbox VALUES ('aeb04dfd-c1b4-4cb5-be6d-d242daa76d0f', 'tenant-c', 'embed', '{"memoryId": "790e574d-8baa-4bca-92a4-bbaf44becc82"}', '2026-10-07 19:12:50.581+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.581+09');
INSERT INTO public.outbox VALUES ('2f5ac83f-4195-4b44-bc9c-82617916d312', 'tenant-c', 'extract', '{"observationId": "c2b3c5ae-db60-400f-84c3-9a67188036d4"}', '2026-10-07 19:12:50.579+09', '2026-10-07 19:12:50.579+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.585+09', NULL, NULL, '2026-10-07 19:12:50.579+09');
INSERT INTO public.outbox VALUES ('a926b226-3e09-4aa6-81dd-eb4aefca6435', 'tenant-c', 'embed', '{"memoryId": "2117a8ae-5aac-450b-b430-7597276db1a2"}', '2026-10-07 19:12:50.587+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.587+09');
INSERT INTO public.outbox VALUES ('70491cc8-183d-4a80-89e5-df0f1616c05d', 'tenant-c', 'extract', '{"observationId": "e274142b-404d-4be4-a9c1-7694651a7d94"}', '2026-10-07 19:12:50.585+09', '2026-10-07 19:12:50.585+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.59+09', NULL, NULL, '2026-10-07 19:12:50.585+09');
INSERT INTO public.outbox VALUES ('f0e716d9-e29e-4f72-9c0b-f2807adfd927', 'tenant-a2', 'extract', '{"observationId": "b31bc462-fa23-4be2-8f65-b90f2dcb84d0"}', '2026-10-07 19:12:50.632+09', '2026-10-07 19:12:50.632+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.637+09', NULL, NULL, '2026-10-07 19:12:50.632+09');
INSERT INTO public.outbox VALUES ('90d6ae0c-c526-40e2-bf52-8bf6a8e44798', 'tenant-a2', 'extract', '{"observationId": "aeec1d0f-746d-4a22-87b0-44a7aecb1305"}', '2026-10-07 19:12:50.638+09', '2026-10-07 19:12:50.638+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.646+09', NULL, NULL, '2026-10-07 19:12:50.638+09');
INSERT INTO public.outbox VALUES ('e9c298d8-ab38-45a2-8557-52d25d5c2f36', 'tenant-a2', 'extract', '{"observationId": "9eee59e2-c7fa-4476-9f1b-2cf8daf4d1b2"}', '2026-10-07 19:12:50.646+09', '2026-10-07 19:12:50.646+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.65+09', NULL, NULL, '2026-10-07 19:12:50.646+09');
INSERT INTO public.outbox VALUES ('ea72a6c4-b823-44b8-b5c1-70c228be60ac', 'tenant-a2', 'extract', '{"observationId": "362be6f1-a44c-4d6e-82de-8f181cd1e52b"}', '2026-10-07 19:12:50.651+09', '2026-10-07 19:12:50.651+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.659+09', NULL, NULL, '2026-10-07 19:12:50.651+09');
INSERT INTO public.outbox VALUES ('8a6ab45b-ccab-4f42-aafe-4d5600220a9a', 'tenant-a2', 'extract', '{"observationId": "4e14258c-ccc0-4310-85f0-d47091c681d2"}', '2026-10-07 19:12:50.66+09', '2026-10-07 19:12:50.66+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.664+09', NULL, NULL, '2026-10-07 19:12:50.66+09');
INSERT INTO public.outbox VALUES ('c01b1832-b166-4649-a90e-9785fd87d9f5', 'tenant-a2', 'extract', '{"observationId": "96f08daa-eb63-40af-bc7c-3443951c21cf"}', '2026-10-07 19:12:50.665+09', '2026-10-07 19:12:50.665+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.67+09', NULL, NULL, '2026-10-07 19:12:50.665+09');
INSERT INTO public.outbox VALUES ('f2159361-3ec5-44a2-8528-b8bab118cf4a', 'tenant-a2', 'extract', '{"observationId": "0a5fe51f-cd65-4108-94bf-9c52fe12b284"}', '2026-10-07 19:12:50.67+09', '2026-10-07 19:12:50.67+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.677+09', NULL, NULL, '2026-10-07 19:12:50.67+09');
INSERT INTO public.outbox VALUES ('7dd0883a-9139-40f6-b371-91ebb59748b1', 'tenant-a2', 'embed', '{"memoryId": "7bcb70db-14e5-4b30-834d-a0c149636e5f"}', '2026-10-07 19:12:50.634+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.701+09', NULL, NULL, '2026-10-07 19:12:50.634+09');
INSERT INTO public.outbox VALUES ('129ad405-3e47-4e44-bd19-525e90b0f139', 'tenant-a2', 'extract', '{"observationId": "4d71dce4-fd28-4028-9e67-3febcb98cae4"}', '2026-10-07 19:12:50.678+09', '2026-10-07 19:12:50.678+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.682+09', NULL, NULL, '2026-10-07 19:12:50.678+09');
INSERT INTO public.outbox VALUES ('376a25ed-08eb-494d-b310-3d2caf5e430e', 'tenant-a2', 'extract', '{"observationId": "4469cb10-1a12-4166-a8c0-be27fe5911cb"}', '2026-10-07 19:12:50.682+09', '2026-10-07 19:12:50.682+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.687+09', NULL, NULL, '2026-10-07 19:12:50.682+09');
INSERT INTO public.outbox VALUES ('741e714a-01bf-422b-a27e-3e424873f9db', 'tenant-a2', 'extract', '{"observationId": "a0ba71ba-b950-42db-b53e-d05021c0fa9b"}', '2026-10-07 19:12:50.688+09', '2026-10-07 19:12:50.688+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.691+09', NULL, NULL, '2026-10-07 19:12:50.688+09');
INSERT INTO public.outbox VALUES ('9f959475-d2bb-4632-beba-f0756657fc45', 'tenant-a2', 'extract', '{"observationId": "b27d6493-8c52-4f5f-a2a4-8e339ef3da4f"}', '2026-10-07 19:12:50.692+09', '2026-10-07 19:12:50.692+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.695+09', NULL, NULL, '2026-10-07 19:12:50.692+09');
INSERT INTO public.outbox VALUES ('b7158d1c-7726-4834-a844-e342fb4b6158', 'tenant-a2', 'embed', '{"memoryId": "a75c0a9e-8fc3-404f-9f01-08bd0a051f71"}', '2026-10-07 19:12:50.64+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.706+09', NULL, NULL, '2026-10-07 19:12:50.64+09');
INSERT INTO public.outbox VALUES ('1bc23c27-47da-40a2-8d8b-dfef258171b5', 'tenant-a2', 'embed', '{"memoryId": "deeae107-b83d-4965-8898-04e20b6c725f"}', '2026-10-07 19:12:50.648+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.709+09', NULL, NULL, '2026-10-07 19:12:50.648+09');
INSERT INTO public.outbox VALUES ('c98385cb-e24f-47d2-9e38-1357f9803216', 'tenant-a2', 'embed', '{"memoryId": "1e76ed11-8f26-4410-b15e-33cf393b2da7"}', '2026-10-07 19:12:50.653+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.712+09', NULL, NULL, '2026-10-07 19:12:50.653+09');
INSERT INTO public.outbox VALUES ('8b0e0617-46b9-4ede-b610-99cafc764367', 'tenant-a2', 'embed', '{"memoryId": "708568e6-0191-4f0e-a63c-af832f595084"}', '2026-10-07 19:12:50.662+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.715+09', NULL, NULL, '2026-10-07 19:12:50.662+09');
INSERT INTO public.outbox VALUES ('7337006d-6247-4578-bff9-b501b240881c', 'tenant-a2', 'embed', '{"memoryId": "7218f6ab-49f5-4800-8530-dbc685bee1fe"}', '2026-10-07 19:12:50.667+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.719+09', NULL, NULL, '2026-10-07 19:12:50.667+09');
INSERT INTO public.outbox VALUES ('ae965fbc-f524-48c1-90ed-ed6f82c64209', 'tenant-a2', 'embed', '{"memoryId": "28d2e134-829b-43cd-96a4-27c990741913"}', '2026-10-07 19:12:50.672+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.723+09', NULL, NULL, '2026-10-07 19:12:50.672+09');
INSERT INTO public.outbox VALUES ('95797362-820b-4ce2-9b19-aac80d7738ec', 'tenant-a2', 'embed', '{"memoryId": "8574a714-8b1b-4dd8-9669-8b8fb66a4fde"}', '2026-10-07 19:12:50.679+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.727+09', NULL, NULL, '2026-10-07 19:12:50.679+09');
INSERT INTO public.outbox VALUES ('cc51d078-6cf8-488e-9e28-6526092a8ddd', 'tenant-a2', 'embed', '{"memoryId": "c73fe627-c93a-4e4c-ae18-9b6313984f2c"}', '2026-10-07 19:12:50.684+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.73+09', NULL, NULL, '2026-10-07 19:12:50.684+09');
INSERT INTO public.outbox VALUES ('73433119-13dc-4fa9-8a77-0dae6bdc220d', 'tenant-a2', 'embed', '{"memoryId": "a0015453-f75e-47e2-b0bc-99f055bd5a4c"}', '2026-10-07 19:12:50.689+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, '2026-10-07 19:12:50.733+09', NULL, NULL, '2026-10-07 19:12:50.689+09');
INSERT INTO public.outbox VALUES ('ed2fee63-49a5-4cfa-b2aa-1fdddd033c48', 'tenant-a2', 'embed', '{"memoryId": "f6c05d07-e9f7-4313-886e-07ec9329f49e"}', '2026-10-07 19:12:50.693+09', '2026-10-07 19:12:50.696+09', 'runtime.tick', 1, NULL, '2026-10-07 19:12:50.735+09', 'fixture: embedding provider failure', '2026-10-07 19:12:50.693+09');
INSERT INTO public.outbox VALUES ('ddd0bc30-a4b0-48dd-8e24-601c1a2f85ed', 'tenant-a2', 'embed', '{"memoryId": "ae32d300-498f-4ab6-9216-e34c3658ca49"}', '2026-10-07 19:12:50.738+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.738+09');
INSERT INTO public.outbox VALUES ('6ae5018d-6904-4b8b-9a9f-45cbbc8f345e', 'tenant-a2', 'extract', '{"observationId": "3a7b4253-481f-472f-962b-d6380095ff1a"}', '2026-10-07 19:12:50.736+09', '2026-10-07 19:12:50.736+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.741+09', NULL, NULL, '2026-10-07 19:12:50.736+09');
INSERT INTO public.outbox VALUES ('0e9df5b3-3fc5-4c8a-96a5-063ec38c6bfc', 'tenant-a2', 'embed', '{"memoryId": "4f23dd19-cf60-4aa8-99c9-67d77f6d484c"}', '2026-10-07 19:12:50.744+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.744+09');
INSERT INTO public.outbox VALUES ('08a94d7d-7716-4282-a9bc-a086bb19a2d0', 'tenant-a2', 'extract', '{"observationId": "b4eb8c6a-c617-4ba7-8e8f-ad17163e20a8"}', '2026-10-07 19:12:50.741+09', '2026-10-07 19:12:50.741+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.748+09', NULL, NULL, '2026-10-07 19:12:50.741+09');
INSERT INTO public.outbox VALUES ('195f34bb-58e7-4d18-b8e9-c2d1912c0661', 'tenant-a2', 'embed', '{"memoryId": "86da63ef-213c-4400-ae9f-d57637485361"}', '2026-10-07 19:12:50.75+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-10-07 19:12:50.75+09');
INSERT INTO public.outbox VALUES ('1c2dba51-68cf-4ceb-bd63-ee99c8b4b7ee', 'tenant-a2', 'extract', '{"observationId": "e5f26b59-5901-4593-8ab4-00afdba5a24e"}', '2026-10-07 19:12:50.748+09', '2026-10-07 19:12:50.748+09', 'runtime.observe:sync', 1, '2026-10-07 19:12:50.752+09', NULL, NULL, '2026-10-07 19:12:50.748+09');


--
-- Data for Name: recall_usages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recall_usages VALUES ('tenant-a', 'b6b59cb7-cecd-4b47-8764-9dbacf91537d', '3c6587dd-bed0-4a33-a929-cef895bcc1c2', '2026-10-07 19:12:50.052611+09');
INSERT INTO public.recall_usages VALUES ('tenant-b', '0c8d8bac-68cd-4c66-8436-ae54a3092f01', '6233d0ba-3289-4b18-bf47-3ad3afd3c613', '2026-10-07 19:12:50.378274+09');
INSERT INTO public.recall_usages VALUES ('tenant-c', 'e13bdcb9-927e-46de-92c3-2bbf214cff9d', '953ed106-e95f-4366-8e11-65e7c7850739', '2026-10-07 19:12:50.629164+09');
INSERT INTO public.recall_usages VALUES ('tenant-a2', '343354ae-8301-446d-9d0c-5669f33ace5e', 'deeae107-b83d-4965-8898-04e20b6c725f', '2026-10-07 19:12:50.780037+09');


--
-- Data for Name: recalls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recalls VALUES ('b6b59cb7-cecd-4b47-8764-9dbacf91537d', 'tenant-a', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "ann_truncated", "certainty": "undecidable", "countKind": "unknown", "undecidableReason": "ANN が返した最後の similarity が 0 以下または非有限である（NaN）。この場合、上界の不等式は total の順序を保証しない。"}, {"kind": "over_limit", "count": 2, "stage": "association", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1357, "byTier": {"full": 0, "index": 898, "digest": 459, "association": 286}, "counter": "heuristic", "indexChars": 898, "estimatedTokens": 527}', '{"groups": [{"key": null, "axis": "subject", "count": 24, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a 未埋め込み 2", "memoryId": "f0e54766-eb5b-4750-a41b-e686eeaf8a26"}, {"digest": "tenant-a 未埋め込み 1", "memoryId": "f113ce19-c359-4019-821e-36a0783e9a4b"}, {"digest": "tenant-a 未埋め込み 0", "memoryId": "f56e4e56-18b6-4be9-8635-66f70bf99079"}, {"digest": "tenant-a FAIL 埋め込み失敗 東京", "memoryId": "ca48985b-a8be-472d-b44d-66f9f27d7427"}, {"digest": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "96b496be-f3f0-4cea-aaa4-6ca6469d2514"}, {"digest": "tenant-a の記憶 7 東京 会議 プロジェクト2", "memoryId": "d75349ca-82d1-417a-a673-858338419917"}, {"digest": "tenant-a の記憶 5 東京 会議 プロジェクト0", "memoryId": "94f35c86-e0c2-4754-849c-68bb1d35bcb7"}, {"digest": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "6125525a-ae5f-4bdf-8cca-a625c29ca568"}], "totalInScope": 24, "digestBandCoverage": {"shown": 8, "eligible": 8, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:50.023Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 20, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 20, "withinLimit": 5, "notComparable": 2, "passedThreshold": 18}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "association", "detail": {"hits": 13, "anchors": 3, "selected": 10}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 15, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 24}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:50.023+09', '{"memories": [{"score": {"decay": 0.9999999491906015, "total": 0.7063611356686186, "strength": 1, "tagMatch": 1, "freshness": 0.9999999491906015, "similarity": 0.7063612074481929, "affinityMeasured": true}, "memoryId": "3c6587dd-bed0-4a33-a929-cef895bcc1c2", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999507951087, "total": 0.7058284836329933, "strength": 1, "tagMatch": 1, "freshness": 0.9999999507951087, "similarity": 0.7058285530934261, "affinityMeasured": true}, "memoryId": "c60d04c8-7f18-40ac-b425-117dcad2b9c4", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999417029009, "total": 0.7057909985176627, "strength": 1, "tagMatch": 1, "freshness": 0.9999999417029009, "similarity": 0.7057910808088055, "affinityMeasured": true}, "memoryId": "45289fa9-c141-49e8-aa27-403947904678", "retrievedVia": "ann"}, {"score": {"decay": 0.999999936889379, "total": 0.7056453511530666, "strength": 1, "tagMatch": 1, "freshness": 0.999999936889379, "similarity": 0.7056454402205076, "affinityMeasured": true}, "memoryId": "95565971-61a9-48d4-8bf0-6146c1b18ab4", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999529344518, "total": 0.70529622112656, "strength": 1, "tagMatch": 1, "freshness": 0.9999999529344518, "similarity": 0.7052962875168712, "affinityMeasured": true}, "memoryId": "165a96af-6587-4299-a87a-b08c581ccf0c", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999384938864, "strength": 1, "tagMatch": 1, "freshness": 0.9999999384938864, "affinityMeasured": false}, "memoryId": "e385d8b3-b308-4c04-906c-e9df8b7efb5b", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.9999999548063769, "strength": 1, "tagMatch": 1, "freshness": 0.9999999548063769, "affinityMeasured": false}, "memoryId": "1031045a-5312-41df-aa4f-cbeb244c9676", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.9999999400983935, "strength": 1, "tagMatch": 1, "freshness": 0.9999999400983935, "affinityMeasured": false}, "memoryId": "8e77776f-9fac-490a-a360-03f046b63b21", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.9999999433074082, "strength": 1, "tagMatch": 1, "freshness": 0.9999999433074082, "affinityMeasured": false}, "memoryId": "8dc7ffd1-b4c8-4396-944e-cc8905b390f2", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.9999999462490048, "strength": 1, "tagMatch": 1, "freshness": 0.9999999462490048, "affinityMeasured": false}, "memoryId": "d83a8a10-71ac-47f7-98cd-866c2109058f", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.9999999478535121, "strength": 1, "tagMatch": 1, "freshness": 0.9999999478535121, "affinityMeasured": false}, "memoryId": "c32a3934-086f-4808-b9f8-bf1d05d13413", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.9999999171004563, "strength": 1, "tagMatch": 1, "freshness": 0.9999999171004563, "affinityMeasured": false}, "memoryId": "30fc99e8-5f10-4be6-8010-b10d910ce337", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.9999999152285313, "strength": 1, "tagMatch": 1, "freshness": 0.9999999152285313, "affinityMeasured": false}, "memoryId": "9da74c9a-e84e-4c92-9403-a9644ddfc4e2", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.999999911752099, "strength": 1, "tagMatch": 1, "freshness": 0.999999911752099, "affinityMeasured": false}, "memoryId": "32b68e43-7607-43ce-968b-0b780cfe4245", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.999999928332007, "strength": 1, "tagMatch": 1, "freshness": 0.999999928332007, "affinityMeasured": false}, "memoryId": "05371d53-f656-469d-be70-9f30b9ea4c0c", "retrievedVia": "association", "associationOf": "3c6587dd-bed0-4a33-a929-cef895bcc1c2"}, {"score": {"decay": 0.999999924053321, "strength": 1, "tagMatch": 1, "freshness": 0.999999924053321, "affinityMeasured": false}, "memoryId": "d0cc5de2-ea0c-475c-bb6a-0a89874cbede", "companionOf": "05371d53-f656-469d-be70-9f30b9ea4c0c", "retrievedVia": "mandatory_companion"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('0c8d8bac-68cd-4c66-8436-ae54a3092f01', 'tenant-b', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "unit_assembly_dropped", "count": 1, "countKind": "lower_bound"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1091, "byTier": {"full": 0, "index": 806, "digest": 285, "association": 140}, "counter": "heuristic", "indexChars": 806, "estimatedTokens": 400}', '{"groups": [{"key": null, "axis": "subject", "count": 17, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-b 未埋め込み 2", "memoryId": "b347bac9-0041-4d10-8a6c-10f4e9c75ebc"}, {"digest": "tenant-b 未埋め込み 1", "memoryId": "8cae5ddc-4556-4e30-8110-48b3c11fcca8"}, {"digest": "tenant-b 未埋め込み 0", "memoryId": "b18db25c-08c7-4b7a-9646-95621eab1b91"}, {"digest": "tenant-b FAIL 埋め込み失敗 東京", "memoryId": "60f0fac6-c743-4f0e-9a42-608e8c215244"}, {"digest": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "cd3efb23-07cb-490c-89d3-23195c957396"}, {"digest": "tenant-b の記憶 6 東京 会議 プロジェクト1", "memoryId": "84d27a31-017c-4d50-b5b2-23a5bfb747c1"}, {"digest": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "263bb4c9-6752-4889-ae08-5a96e72c4902"}], "totalInScope": 17, "digestBandCoverage": {"shown": 7, "eligible": 7, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:50.366Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 13, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 13, "withinLimit": 5, "notComparable": 2, "passedThreshold": 11}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "association", "detail": {"hits": 6, "anchors": 3, "selected": 6}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 10, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 17}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:50.366+09', '{"memories": [{"score": {"decay": 0.9999999390287221, "total": 0.6564809617075028, "strength": 1, "tagMatch": 1, "freshness": 0.9999999390287221, "similarity": 0.6564810417604764, "affinityMeasured": true}, "memoryId": "6233d0ba-3289-4b18-bf47-3ad3afd3c613", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999376916328, "total": 0.6564711917972053, "strength": 1, "tagMatch": 1, "freshness": 0.9999999376916328, "similarity": 0.6564712736045092, "affinityMeasured": true}, "memoryId": "453b883d-1d64-4397-b6bd-f9b42c4d9a52", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999363545433, "total": 0.6564611830601357, "strength": 1, "tagMatch": 1, "freshness": 0.9999999363545433, "similarity": 0.6564612666216871, "affinityMeasured": true}, "memoryId": "b01b630d-8c27-43b0-934a-759588d7f954", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999475860942, "total": 0.6554165497984779, "strength": 1, "tagMatch": 1, "freshness": 0.9999999475860942, "similarity": 0.6554166185043658, "affinityMeasured": true}, "memoryId": "e5987c84-2225-4e1c-8df0-59615e473121", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999406332294, "total": 0.6554060269035599, "strength": 1, "tagMatch": 1, "freshness": 0.9999999406332294, "similarity": 0.6554061047222453, "affinityMeasured": true}, "memoryId": "fc49847e-02c0-4b33-a5fb-f4cb7bd4ebb5", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999181701279, "strength": 1, "tagMatch": 1, "freshness": 0.9999999181701279, "affinityMeasured": false}, "memoryId": "3f2ddb6d-3ebb-4f2c-b820-967569432b05", "retrievedVia": "association", "associationOf": "6233d0ba-3289-4b18-bf47-3ad3afd3c613"}, {"score": {"decay": 0.9999999197746351, "strength": 1, "tagMatch": 1, "freshness": 0.9999999197746351, "affinityMeasured": false}, "memoryId": "0ec8e879-c4d6-448c-9751-1857aec8159e", "retrievedVia": "association", "associationOf": "6233d0ba-3289-4b18-bf47-3ad3afd3c613"}, {"score": {"decay": 0.9999999216465602, "strength": 1, "tagMatch": 1, "freshness": 0.9999999216465602, "affinityMeasured": false}, "memoryId": "e8d5424f-0a9a-451e-9f14-77d672705c70", "retrievedVia": "association", "associationOf": "6233d0ba-3289-4b18-bf47-3ad3afd3c613"}, {"score": {"decay": 0.999999926460082, "strength": 1, "tagMatch": 1, "freshness": 0.999999926460082, "affinityMeasured": false}, "memoryId": "5cab23bf-8349-4f08-82c4-fcc05b183999", "retrievedVia": "association", "associationOf": "6233d0ba-3289-4b18-bf47-3ad3afd3c613"}, {"score": {"decay": 0.9999999302039322, "strength": 1, "tagMatch": 1, "freshness": 0.9999999302039322, "affinityMeasured": false}, "memoryId": "9b1fa9a7-1d68-4d06-82b7-029b5e425d28", "retrievedVia": "association", "associationOf": "6233d0ba-3289-4b18-bf47-3ad3afd3c613"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('e13bdcb9-927e-46de-92c3-2bbf214cff9d', 'tenant-c', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 784, "byTier": {"full": 0, "index": 616, "digest": 168, "association": 0}, "counter": "heuristic", "indexChars": 616, "estimatedTokens": 272}', '{"groups": [{"key": null, "axis": "subject", "count": 11, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-c 未埋め込み 2", "memoryId": "2117a8ae-5aac-450b-b430-7597276db1a2"}, {"digest": "tenant-c 未埋め込み 1", "memoryId": "790e574d-8baa-4bca-92a4-bbaf44becc82"}, {"digest": "tenant-c 未埋め込み 0", "memoryId": "7feac528-333d-4360-85af-c2e8303b98fb"}, {"digest": "tenant-c FAIL 埋め込み失敗 東京", "memoryId": "c1e8190f-a6d8-4534-bcfd-318832da049a"}, {"digest": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "36b1914c-9a39-49c8-a1ca-0e7d9aba6101"}], "totalInScope": 11, "digestBandCoverage": {"shown": 5, "eligible": 5, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:50.612Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 7, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 7, "withinLimit": 5, "notComparable": 1, "passedThreshold": 6}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "association", "detail": {"hits": 0, "anchors": 3, "selected": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 11}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:50.612+09', '{"memories": [{"score": {"decay": 0.9999999422377366, "total": 0.5446698816551013, "strength": 1, "tagMatch": 1, "freshness": 0.9999999422377366, "similarity": 0.5446699445778371, "affinityMeasured": true}, "memoryId": "953ed106-e95f-4366-8e11-65e7c7850739", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999403658115, "total": 0.5442745283187052, "strength": 1, "tagMatch": 1, "freshness": 0.9999999403658115, "similarity": 0.5442745932334506, "affinityMeasured": true}, "memoryId": "a99765fb-053f-4be4-ae02-213c695e85ec", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999513299446, "total": 0.5442010648005181, "strength": 1, "tagMatch": 1, "freshness": 0.9999999513299446, "similarity": 0.544201117773114, "affinityMeasured": true}, "memoryId": "294f74c8-caf3-43f9-b986-3b9fc00620ca", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999478535121, "strength": 1, "tagMatch": 1, "freshness": 0.9999999478535121, "affinityMeasured": false}, "memoryId": "5288b42a-c6a1-43ed-8586-d61148b7b554", "companionOf": "294f74c8-caf3-43f9-b986-3b9fc00620ca", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999387613042, "total": 0.5438775404340177, "strength": 1, "tagMatch": 1, "freshness": 0.9999999387613042, "similarity": 0.5438776070467263, "affinityMeasured": true}, "memoryId": "87b0af80-4a09-483a-8937-d7a8299cf069", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999494580194, "total": 0.543807629950523, "strength": 1, "tagMatch": 1, "freshness": 0.9999999494580194, "similarity": 0.5438076849207566, "affinityMeasured": true}, "memoryId": "3fd82bd2-eb5c-4ef0-b063-859fd53c4924", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('343354ae-8301-446d-9d0c-5669f33ace5e', 'tenant-a2', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 662, "byTier": {"full": 0, "index": 459, "digest": 203, "association": 29}, "counter": "heuristic", "indexChars": 459, "estimatedTokens": 244}', '{"groups": [{"key": null, "axis": "subject", "count": 10, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a2 未埋め込み 2", "memoryId": "86da63ef-213c-4400-ae9f-d57637485361"}, {"digest": "tenant-a2 FAIL 埋め込み失敗 東京", "memoryId": "f6c05d07-e9f7-4313-886e-07ec9329f49e"}, {"digest": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "1e76ed11-8f26-4410-b15e-33cf393b2da7"}], "totalInScope": 10, "digestBandCoverage": {"shown": 3, "eligible": 3, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"labels": null, "validAt": "2026-10-07T10:12:50.767Z", "subjectId": null, "attributes": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 8, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 8, "withinLimit": 5, "notComparable": 1, "passedThreshold": 7}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "association", "detail": {"hits": 1, "anchors": 3, "selected": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 6, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 10}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-10-07 19:12:50.767+09', '{"memories": [{"score": {"decay": 0.9999999681772711, "total": 0.3296480654708269, "strength": 1, "tagMatch": 1, "freshness": 0.9999999681772711, "similarity": 0.32964808645142996, "affinityMeasured": true}, "memoryId": "deeae107-b83d-4965-8898-04e20b6c725f", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999775368972, "total": 0.32951252160686123, "strength": 1, "tagMatch": 1, "freshness": 0.9999999775368972, "similarity": 0.32951253641060907, "affinityMeasured": true}, "memoryId": "c73fe627-c93a-4e4c-ae18-9b6313984f2c", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999745953004, "strength": 1, "tagMatch": 1, "freshness": 0.9999999745953004, "affinityMeasured": false}, "memoryId": "28d2e134-829b-43cd-96a4-27c990741913", "companionOf": "c73fe627-c93a-4e4c-ae18-9b6313984f2c", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999660379281, "total": 0.329202628910637, "strength": 1, "tagMatch": 1, "freshness": 0.9999999660379281, "similarity": 0.3292026512714449, "affinityMeasured": true}, "memoryId": "a75c0a9e-8fc3-404f-9f01-08bd0a051f71", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999764672256, "total": 0.3290689906037943, "strength": 1, "tagMatch": 1, "freshness": 0.9999999764672256, "similarity": 0.3290690060916075, "affinityMeasured": true}, "memoryId": "8574a714-8b1b-4dd8-9669-8b8fb66a4fde", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999644334208, "total": 0.32875653719444753, "strength": 1, "tagMatch": 1, "freshness": 0.9999999644334208, "similarity": 0.3287565605799396, "affinityMeasured": true}, "memoryId": "7bcb70db-14e5-4b30-834d-a0c149636e5f", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999729907931, "strength": 1, "tagMatch": 1, "freshness": 0.9999999729907931, "affinityMeasured": false}, "memoryId": "7218f6ab-49f5-4800-8530-dbc685bee1fe", "retrievedVia": "association", "associationOf": "deeae107-b83d-4965-8898-04e20b6c725f"}], "breakdownCaptured": true}');


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
-- Name: memory_relations memory_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_pkey PRIMARY KEY (id);


--
-- Name: memory_relations memory_relations_tenant_id_from_memory_id_to_memory_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_tenant_id_from_memory_id_to_memory_id_kind_key UNIQUE (tenant_id, from_memory_id, to_memory_id, kind);


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
-- Name: idx_memories_claim_predicates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_claim_predicates ON public.memories USING btree (tenant_id, subject_id, claim_key_predicate, created_at) WHERE ((status = 'active'::text) AND (claim_key_subject IS NOT NULL) AND (claim_key_predicate IS NOT NULL));


--
-- Name: idx_memories_contested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested ON public.memories USING btree (tenant_id, status) WHERE (status = 'contested'::text);


--
-- Name: idx_memories_contested_with; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested_with ON public.memories USING btree (contested_with_id) WHERE (contested_with_id IS NOT NULL);


--
-- Name: idx_memories_digest_band; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_digest_band ON public.memories USING btree (tenant_id, COALESCE(occurred_at, recorded_at) DESC, id DESC) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


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
-- Name: idx_memories_source_observation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_source_observation_id ON public.memories USING btree (source_observation_id);


--
-- Name: idx_memories_superseded_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_superseded_by ON public.memories USING btree (tenant_id, superseded_by_id) WHERE (superseded_by_id IS NOT NULL);


--
-- Name: idx_memories_superseded_by_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_superseded_by_id ON public.memories USING btree (superseded_by_id);


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
-- Name: idx_memory_embeddings_memory_id_some_very_long_provide_0428309b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_memory_id_some_very_long_provide_0428309b ON public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 USING btree (memory_id);


--
-- Name: idx_memory_embeddings_memory_id_test_fixture_model_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_memory_id_test_fixture_model_3 ON public.memory_embeddings_test_fixture_model_3 USING btree (memory_id);


--
-- Name: idx_memory_embeddings_memory_id_testkit_deterministic_8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_memory_id_testkit_deterministic_8 ON public.memory_embeddings_testkit_deterministic_8 USING btree (memory_id);


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
-- Name: idx_memory_events_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_memory_id ON public.memory_events USING btree (memory_id);


--
-- Name: idx_memory_labels_by_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_by_label ON public.memory_labels USING btree (tenant_id, label_id);


--
-- Name: idx_memory_labels_label_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_label_id ON public.memory_labels USING btree (label_id);


--
-- Name: idx_memory_labels_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_labels_memory_id ON public.memory_labels USING btree (memory_id);


--
-- Name: idx_memory_relations_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_from ON public.memory_relations USING btree (tenant_id, from_memory_id, kind);


--
-- Name: idx_memory_relations_from_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_from_memory_id ON public.memory_relations USING btree (from_memory_id);


--
-- Name: idx_memory_relations_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_to ON public.memory_relations USING btree (tenant_id, to_memory_id, kind);


--
-- Name: idx_memory_relations_to_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_relations_to_memory_id ON public.memory_relations USING btree (to_memory_id);


--
-- Name: idx_observations_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observations_by_subject ON public.observations USING btree (tenant_id, subject_id, recorded_at);


--
-- Name: idx_outbox_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_claimable ON public.outbox USING btree (tenant_id, available_at) WHERE ((completed_at IS NULL) AND (failed_at IS NULL));


--
-- Name: idx_outbox_completed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_completed ON public.outbox USING btree (tenant_id, completed_at, id) WHERE (completed_at IS NOT NULL);


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_pending ON public.outbox USING btree (tenant_id, kind, available_at) WHERE ((completed_at IS NULL) AND (claimed_at IS NULL));


--
-- Name: idx_recall_usages_memory_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recall_usages_memory_id ON public.recall_usages USING btree (memory_id);


--
-- Name: idx_recall_usages_recall_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recall_usages_recall_id ON public.recall_usages USING btree (recall_id);


--
-- Name: idx_recalls_by_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_by_created ON public.recalls USING btree (tenant_id, created_at, id);


--
-- Name: idx_recalls_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_by_subject ON public.recalls USING btree (tenant_id, subject_id, created_at);


--
-- Name: idx_recalls_digest_band; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_digest_band ON public.recalls USING gin (((index_band -> 'digestBand'::text)) jsonb_path_ops);


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
-- Name: memory_relations memory_relations_from_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_from_memory_id_fkey FOREIGN KEY (from_memory_id) REFERENCES public.memories(id);


--
-- Name: memory_relations memory_relations_to_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_relations
    ADD CONSTRAINT memory_relations_to_memory_id_fkey FOREIGN KEY (to_memory_id) REFERENCES public.memories(id);


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


